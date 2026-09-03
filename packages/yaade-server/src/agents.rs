use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use axum::{
    Json, Router,
    body::Bytes,
    extract::{
        DefaultBodyLimit, Path, Query, State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, patch, post},
};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use futures_util::StreamExt as _;
use rusqlite::{OptionalExtension, Row, params};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use sha2::{Digest as _, Sha256};
use subtle::ConstantTimeEq as _;
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt as _, AsyncWriteExt as _, BufReader},
    process::{ChildStdin, Command},
    sync::{Mutex as AsyncMutex, Semaphore, broadcast},
};
use uuid::Uuid;

use crate::{config::path_allowed, model::now_iso, runtime::HostRuntime, store::StateStore};

const MIGRATION: &str = r#"
CREATE TABLE IF NOT EXISTS agent_projects (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_profiles (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  system_prompt TEXT NOT NULL,
  system_prompt_mode TEXT NOT NULL,
  cwd TEXT NOT NULL,
  tools_json TEXT,
  model_provider TEXT,
  model_id TEXT,
  thinking_level TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY NOT NULL,
  agent_id TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE RESTRICT,
  prompt TEXT NOT NULL,
  model_provider TEXT,
  model_id TEXT,
  thinking_level TEXT,
  cwd TEXT NOT NULL,
  execution_mode TEXT NOT NULL DEFAULT 'local',
  worktree_id TEXT,
  parent_run_id TEXT,
  status TEXT NOT NULL,
  error_code TEXT,
  error_message TEXT,
  session_file TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
);
CREATE TABLE IF NOT EXISTS agent_events (
  agent_id TEXT NOT NULL,
  run_id TEXT,
  sequence INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(agent_id, sequence)
);
CREATE TABLE IF NOT EXISTS agent_run_attachments (
  run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY(run_id, position)
);
CREATE TABLE IF NOT EXISTS agent_inbox (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL,
  run_id TEXT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  options_json TEXT NOT NULL,
  status TEXT NOT NULL,
  response TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS agent_runs_agent_status_idx ON agent_runs(agent_id,status,created_at DESC);
CREATE INDEX IF NOT EXISTS agent_events_run_sequence_idx ON agent_events(run_id,sequence);
"#;

const COMMAND_MIGRATION: &str = r#"
CREATE UNIQUE INDEX IF NOT EXISTS agent_one_active_run_idx
  ON agent_runs(agent_id) WHERE status IN ('queued','running');
CREATE TABLE IF NOT EXISTS agent_command_receipts (
  id TEXT PRIMARY KEY NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  agent_id TEXT NOT NULL,
  command TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  result_json TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
"#;

#[derive(Clone)]
struct AgentsState {
    runtime: Arc<HostRuntime>,
    active: Arc<Mutex<HashMap<String, Arc<AsyncMutex<ChildStdin>>>>>,
    tickets: Arc<Mutex<HashMap<String, Instant>>>,
    model_catalog: Arc<AsyncMutex<Option<Value>>>,
    stream_limit: Arc<Semaphore>,
    events: broadcast::Sender<AgentEventEnvelope>,
}

#[derive(Clone)]
struct AgentEventEnvelope {
    agent_id: String,
    run_id: Option<String>,
    value: Value,
}

pub(crate) fn router<S>(runtime: Arc<HostRuntime>) -> Result<Router<S>, AgentError>
where
    S: Clone + Send + Sync + 'static,
{
    runtime
        .store
        .apply_feature_migration("0200-agents", MIGRATION)
        .map_err(AgentError::storage)?;
    reconcile_runs(&runtime.store)?;
    runtime
        .store
        .apply_feature_migration("0201-agent-command-receipts", COMMAND_MIGRATION)
        .map_err(AgentError::storage)?;
    reconcile_receipts(&runtime.store)?;
    let (events, _) = broadcast::channel(1_024);
    let state = AgentsState {
        runtime,
        active: Arc::new(Mutex::new(HashMap::new())),
        tickets: Arc::new(Mutex::new(HashMap::new())),
        model_catalog: Arc::new(AsyncMutex::new(None)),
        stream_limit: Arc::new(Semaphore::new(20)),
        events,
    };
    Ok(Router::new()
        .route("/v1/health", get(health))
        .route("/v1/ws-tickets", post(create_ticket))
        .route("/v1/models", get(models))
        .route("/v1/extensions", get(extensions))
        .route("/v1/extensions/update", post(extensions))
        .route("/v1/composer/suggestions", get(composer_suggestions))
        .route("/v1/projects", get(list_projects).post(create_project))
        .route(
            "/v1/projects/{project_id}",
            patch(update_project).delete(delete_project),
        )
        .route("/v1/agents", get(list_agents).post(create_agent))
        .route(
            "/v1/agents/{agent_id}",
            get(get_agent).patch(update_agent).delete(delete_agent),
        )
        .route("/v1/agents/{agent_id}/events", get(agent_events))
        .route("/v1/agents/{agent_id}/stream", get(agent_stream))
        .route("/v1/runs", get(list_runs).post(create_run))
        .route("/v1/runs/{run_id}", get(get_run))
        .route("/v1/runs/{run_id}/events", get(run_events))
        .route("/v1/runs/{run_id}/stream", get(run_stream))
        .route("/v1/runs/{run_id}/attachments", get(run_attachments))
        .route("/v1/runs/{run_id}/debug-log", get(run_debug_log))
        .route("/v1/runs/{run_id}/changes", get(run_changes))
        .route("/v1/runs/{run_id}/cancel", post(cancel_run))
        .route("/v1/runs/{run_id}/steer", post(steer_run))
        .route("/v1/runs/{run_id}/follow-up", post(follow_up_run))
        .route(
            "/v1/command-receipts/{idempotency_key}",
            get(command_receipt),
        )
        .route("/v1/fleet", get(fleet))
        .route(
            "/v1/worktrees",
            get(empty_worktrees).post(worktrees_unavailable),
        )
        .route(
            "/v1/worktrees/{id}",
            axum::routing::delete(worktrees_unavailable),
        )
        .route(
            "/v1/terminal-sessions",
            get(empty_terminal_sessions).post(terminal_unavailable),
        )
        .route("/v1/terminal-sessions/{id}", get(terminal_unavailable))
        .route(
            "/v1/terminal-sessions/{id}/input",
            post(terminal_unavailable),
        )
        .route(
            "/v1/terminal-sessions/{id}/cancel",
            post(terminal_unavailable),
        )
        .route("/v1/inbox", get(list_inbox).post(create_inbox))
        .route("/v1/inbox/{id}/resolve", post(resolve_inbox))
        .route("/v1/inbox/{id}/cancel", post(cancel_inbox))
        .route("/v1/sessions/search", get(search_sessions))
        .layer(DefaultBodyLimit::max(34_000_000))
        .with_state::<S>(state))
}

#[derive(Clone, Debug)]
pub(crate) struct AgentError {
    status: StatusCode,
    code: &'static str,
    message: String,
}

impl AgentError {
    fn bad(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            code,
            message: message.into(),
        }
    }
    fn not_found(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            code,
            message: message.into(),
        }
    }
    fn conflict(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::CONFLICT,
            code,
            message: message.into(),
        }
    }
    fn storage(error: impl std::fmt::Display) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "database_error",
            message: error.to_string(),
        }
    }
}

impl std::fmt::Display for AgentError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for AgentError {}
impl IntoResponse for AgentError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(json!({ "error": { "code": self.code, "message": self.message } })),
        )
            .into_response()
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Agent {
    id: String,
    name: String,
    system_prompt: String,
    system_prompt_mode: String,
    model: Option<ModelRef>,
    thinking_level: Option<String>,
    cwd: String,
    tools: Option<Vec<String>>,
    created_at: String,
    updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ModelRef {
    provider: String,
    id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Run {
    id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    acknowledgement_id: Option<String>,
    agent_id: String,
    prompt: String,
    model: Option<ModelRef>,
    thinking_level: Option<String>,
    cwd: String,
    execution_mode: String,
    worktree_id: Option<String>,
    parent_run_id: Option<String>,
    latest_event_sequence: i64,
    status: String,
    error: Option<RunError>,
    created_at: String,
    started_at: Option<String>,
    completed_at: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
struct RunError {
    code: String,
    message: String,
}

fn agent_from_row(row: &Row<'_>) -> rusqlite::Result<Agent> {
    let tools_json: Option<String> = row.get(5)?;
    let model_provider: Option<String> = row.get(6)?;
    let model_id: Option<String> = row.get(7)?;
    Ok(Agent {
        id: row.get(0)?,
        name: row.get(1)?,
        system_prompt: row.get(2)?,
        system_prompt_mode: row.get(3)?,
        cwd: row.get(4)?,
        tools: tools_json.and_then(|value| serde_json::from_str(&value).ok()),
        model: model_provider
            .zip(model_id)
            .map(|(provider, id)| ModelRef { provider, id }),
        thinking_level: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

fn run_from_row(row: &Row<'_>) -> rusqlite::Result<Run> {
    let model_provider: Option<String> = row.get(3)?;
    let model_id: Option<String> = row.get(4)?;
    let error_code: Option<String> = row.get(12)?;
    let error_message: Option<String> = row.get(13)?;
    Ok(Run {
        id: row.get(0)?,
        acknowledgement_id: None,
        agent_id: row.get(1)?,
        prompt: row.get(2)?,
        model: model_provider
            .zip(model_id)
            .map(|(provider, id)| ModelRef { provider, id }),
        thinking_level: row.get(5)?,
        cwd: row.get(6)?,
        execution_mode: row.get(7)?,
        worktree_id: row.get(8)?,
        parent_run_id: row.get(9)?,
        status: row.get(10)?,
        latest_event_sequence: row.get(11)?,
        error: error_code
            .zip(error_message)
            .map(|(code, message)| RunError { code, message }),
        created_at: row.get(14)?,
        started_at: row.get(15)?,
        completed_at: row.get(16)?,
    })
}

const AGENT_SELECT: &str = "SELECT id,name,system_prompt,system_prompt_mode,cwd,tools_json,model_provider,model_id,thinking_level,created_at,updated_at FROM agent_profiles";
const RUN_SELECT: &str = "SELECT r.id,r.agent_id,r.prompt,r.model_provider,r.model_id,r.thinking_level,r.cwd,r.execution_mode,r.worktree_id,r.parent_run_id,r.status,COALESCE(MAX(e.sequence),0),r.error_code,r.error_message,r.created_at,r.started_at,r.completed_at FROM agent_runs r LEFT JOIN agent_events e ON e.run_id=r.id";

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ListQuery {
    limit: Option<usize>,
    cursor: Option<String>,
    agent_id: Option<String>,
    status: Option<String>,
}

fn list_limit(query: &ListQuery) -> Result<usize, AgentError> {
    let limit = query.limit.unwrap_or(50);
    if !(1..=100).contains(&limit) {
        return Err(AgentError::bad(
            "validation_failed",
            "Page limit must be between 1 and 100",
        ));
    }
    Ok(limit)
}

fn decode_cursor(cursor: Option<&str>) -> Result<Option<(String, String)>, AgentError> {
    let Some(cursor) = cursor else {
        return Ok(None);
    };
    let Some((timestamp, id)) = cursor.split_once('|') else {
        return Err(AgentError::bad(
            "validation_failed",
            "Pagination cursor is invalid",
        ));
    };
    if timestamp.is_empty() || Uuid::parse_str(id).is_err() {
        return Err(AgentError::bad(
            "validation_failed",
            "Pagination cursor is invalid",
        ));
    }
    Ok(Some((timestamp.to_owned(), id.to_owned())))
}

fn encode_cursor(timestamp: &str, id: &str) -> String {
    format!("{timestamp}|{id}")
}

struct ReceiptAdmission {
    id: String,
    replay: Option<Value>,
}

struct ReceiptRow {
    id: String,
    agent_id: String,
    command: String,
    request_hash: String,
    status: String,
    result: Option<Value>,
    error_code: Option<String>,
    error_message: Option<String>,
    created_at: String,
    updated_at: String,
    completed_at: Option<String>,
}

async fn health() -> Json<Value> {
    Json(json!({
        "status": "ok",
        "service": "agents",
        "requestId": Uuid::new_v4().to_string(),
    }))
}

async fn create_ticket(State(state): State<AgentsState>) -> Json<Value> {
    const TICKET_TTL: Duration = Duration::from_secs(30);
    const MAX_TICKETS: usize = 1_024;
    let ticket = Uuid::new_v4().to_string();
    let now = Instant::now();
    let mut tickets = lock(&state.tickets);
    tickets.retain(|_, created_at| now.duration_since(*created_at) <= TICKET_TTL);
    if tickets.len() >= MAX_TICKETS
        && let Some(oldest) = tickets
            .iter()
            .min_by_key(|(_, created_at)| **created_at)
            .map(|(ticket, _)| ticket.clone())
    {
        tickets.remove(&oldest);
    }
    tickets.insert(ticket.clone(), now);
    let expires_at = jiff::Timestamp::now()
        .checked_add(jiff::SignedDuration::from_secs(30))
        .map_or_else(|_| now_iso(), |value| value.to_string());
    Json(json!({ "ticket": ticket, "expiresAt": expires_at }))
}

async fn models(State(state): State<AgentsState>) -> Json<Value> {
    let mut catalog = state.model_catalog.lock().await;
    if let Some(value) = catalog.as_ref() {
        return Json(value.clone());
    }
    let executable = std::env::var("PI_EXECUTABLE").unwrap_or_else(|_| "pi".to_owned());
    let mut command = Command::new(executable);
    command.arg("--list-models").kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(10), command.output()).await;
    let value = match output {
        Ok(Ok(output)) if output.status.success() => {
            let models = String::from_utf8_lossy(&output.stdout)
                .lines()
                .skip_while(|line| !line.trim_start().starts_with("provider"))
                .skip(1)
                .filter_map(|line| {
                    let mut columns = line.split_whitespace();
                    let provider = columns.next()?;
                    let id = columns.next()?;
                    Some(json!({ "provider": provider, "id": id, "name": id }))
                })
                .collect::<Vec<_>>();
            json!({ "defaultModel": models.first().cloned(), "models": models })
        }
        _ => json!({ "models": [], "defaultModel": null }),
    };
    *catalog = Some(value.clone());
    Json(value)
}

async fn extensions(State(state): State<AgentsState>) -> Json<Value> {
    Json(
        json!({ "extensions": [], "cwd": state.runtime.config.launch_config.workspace_path, "checkedAt": now_iso(), "updateCheckError": null }),
    )
}

#[derive(Deserialize)]
struct SuggestQuery {
    cwd: String,
    kind: String,
    prefix: String,
}
async fn composer_suggestions(
    State(state): State<AgentsState>,
    Query(query): Query<SuggestQuery>,
) -> Result<Json<Value>, AgentError> {
    let cwd = allowed_directory(&state.runtime, &query.cwd)?;
    let mut suggestions = Vec::new();
    if query.kind == "file" {
        let (parent, needle) = query
            .prefix
            .rsplit_once('/')
            .map_or(("", query.prefix.as_str()), |(parent, needle)| {
                (parent, needle)
            });
        let directory = cwd.join(parent);
        if let Ok(entries) = std::fs::read_dir(&directory) {
            for entry in entries.flatten().take(100) {
                let name = entry.file_name().to_string_lossy().into_owned();
                if !name.to_lowercase().contains(&needle.to_lowercase()) {
                    continue;
                }
                let value = if parent.is_empty() {
                    name.clone()
                } else {
                    format!("{parent}/{name}")
                };
                suggestions.push(json!({ "value": value, "label": name, "kind": if entry.path().is_dir() { "directory" } else { "file" } }));
            }
        }
    }
    Ok(Json(json!({ "cwd": cwd, "suggestions": suggestions })))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateProject {
    path: String,
    name: Option<String>,
}
async fn create_project(
    State(state): State<AgentsState>,
    body: Bytes,
) -> Result<(StatusCode, Json<Value>), AgentError> {
    let input: CreateProject = decode(&body)?;
    validate_text(input.path.trim(), 4_096, "path")?;
    if let Some(name) = &input.name {
        validate_text(name.trim(), 256, "name")?;
    }
    let path = allowed_directory(&state.runtime, input.path.trim())?;
    let canonical = path.to_string_lossy().into_owned();
    let requested_name = input.name.as_ref().map(|value| value.trim().to_owned());
    let name = input
        .name
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| {
            path.file_name().map_or_else(
                || canonical.clone(),
                |name| name.to_string_lossy().into_owned(),
            )
        });
    let now = now_iso();
    let id = Uuid::new_v4().to_string();
    let lookup = canonical.clone();
    state.runtime.store.with_connection(move |connection| {
        connection.execute("INSERT INTO agent_projects(id,name,path,created_at,updated_at,last_used_at) VALUES(?,?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET name=COALESCE(?,name),updated_at=excluded.updated_at,last_used_at=excluded.last_used_at", params![id,name,canonical,now,now,now,requested_name])?;
        connection.query_row("SELECT json_object('id',id,'name',name,'path',path,'createdAt',created_at,'updatedAt',updated_at,'lastUsedAt',last_used_at) FROM agent_projects WHERE path=?", [lookup], |row| row.get::<_, String>(0))
    }).map_err(AgentError::storage).and_then(|encoded| serde_json::from_str(&encoded).map_err(AgentError::storage)).map(|value| (StatusCode::CREATED, Json(value)))
}

async fn list_projects(
    State(state): State<AgentsState>,
    Query(query): Query<ListQuery>,
) -> Result<Json<Value>, AgentError> {
    let limit = list_limit(&query)?;
    let cursor = decode_cursor(query.cursor.as_deref())?;
    let mut rows = state.runtime.store.with_connection(move |connection| {
        let mut sql = "SELECT json_object('id',id,'name',name,'path',path,'createdAt',created_at,'updatedAt',updated_at,'lastUsedAt',last_used_at),last_used_at,id FROM agent_projects WHERE 1=1".to_owned();
        let mut values = Vec::new();
        if let Some((timestamp, id)) = cursor {
            sql.push_str(" AND (last_used_at<? OR (last_used_at=? AND id<?))");
            values.extend([timestamp.clone(), timestamp, id]);
        }
        sql.push_str(&format!(" ORDER BY last_used_at DESC,id DESC LIMIT {}", limit + 1));
        let mut statement = connection.prepare(&sql)?;
        statement.query_map(rusqlite::params_from_iter(values), |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))
        })?.collect::<rusqlite::Result<Vec<_>>>()
    }).map_err(AgentError::storage)?;
    let has_more = rows.len() > limit;
    rows.truncate(limit);
    let next_cursor = has_more
        .then(|| {
            rows.last()
                .map(|(_, timestamp, id)| encode_cursor(timestamp, id))
        })
        .flatten();
    let projects = rows
        .into_iter()
        .filter_map(|(value, _, _)| serde_json::from_str::<Value>(&value).ok())
        .collect::<Vec<_>>();
    Ok(Json(
        json!({ "projects": projects, "nextCursor": next_cursor }),
    ))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UpdateProject {
    name: Option<String>,
    path: Option<String>,
}

async fn update_project(
    State(state): State<AgentsState>,
    Path(id): Path<String>,
    body: Bytes,
) -> Result<Json<Value>, AgentError> {
    let input: UpdateProject = decode(&body)?;
    if input.name.is_none() && input.path.is_none() {
        return Err(AgentError::bad(
            "validation_failed",
            "At least one project field must be provided",
        ));
    }
    if let Some(name) = &input.name {
        validate_text(name.trim(), 256, "name")?;
    }
    if let Some(path) = &input.path {
        validate_text(path.trim(), 4_096, "path")?;
    }
    let current = find_project(&state.runtime.store, &id)?;
    let name = input
        .name
        .as_deref()
        .unwrap_or_else(|| {
            current
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("Project")
        })
        .trim()
        .to_owned();
    let requested_path = input
        .path
        .as_deref()
        .unwrap_or_else(|| current.get("path").and_then(Value::as_str).unwrap_or("."));
    let path = allowed_directory(&state.runtime, requested_path)?
        .to_string_lossy()
        .into_owned();
    let update_id = id.clone();
    state
        .runtime
        .store
        .with_connection(move |connection| {
            connection.execute(
                "UPDATE agent_projects SET name=?,path=?,updated_at=? WHERE id=?",
                params![name, path, now_iso(), update_id],
            )
        })
        .map_err(AgentError::storage)?;
    Ok(Json(find_project(&state.runtime.store, &id)?))
}

async fn delete_project(
    State(state): State<AgentsState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, AgentError> {
    let project = find_project(&state.runtime.store, &id)?;
    state
        .runtime
        .store
        .with_connection(move |connection| {
            connection.execute("DELETE FROM agent_projects WHERE id=?", [id])
        })
        .map_err(AgentError::storage)?;
    Ok(Json(project))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateAgent {
    name: Option<String>,
    system_prompt: String,
    system_prompt_mode: Option<String>,
    cwd: Option<String>,
    tools: Option<Vec<String>>,
    model: Option<ModelRef>,
    thinking_level: Option<String>,
}

fn validate_text(value: &str, max: usize, field: &str) -> Result<(), AgentError> {
    if value.is_empty() || value.len() > max {
        return Err(AgentError::bad(
            "validation_failed",
            format!("{field} must contain between 1 and {max} bytes"),
        ));
    }
    Ok(())
}

fn validate_model(model: &ModelRef) -> Result<(), AgentError> {
    validate_text(model.provider.trim(), 256, "model.provider")?;
    validate_text(model.id.trim(), 512, "model.id")
}

fn validate_thinking_level(level: &str) -> Result<(), AgentError> {
    if matches!(
        level,
        "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
    ) {
        Ok(())
    } else {
        Err(AgentError::bad(
            "validation_failed",
            "thinkingLevel is not supported",
        ))
    }
}

fn validate_agent_request(input: &CreateAgent) -> Result<(), AgentError> {
    validate_text(&input.system_prompt, 250_000, "systemPrompt")?;
    if let Some(name) = &input.name {
        validate_text(name.trim(), 256, "name")?;
    }
    if !matches!(
        input.system_prompt_mode.as_deref().unwrap_or("append"),
        "append" | "replace"
    ) {
        return Err(AgentError::bad(
            "validation_failed",
            "systemPromptMode must be append or replace",
        ));
    }
    if let Some(cwd) = &input.cwd {
        validate_text(cwd.trim(), 4_096, "cwd")?;
    }
    if let Some(model) = &input.model {
        validate_model(model)?;
    }
    if let Some(level) = &input.thinking_level {
        validate_thinking_level(level)?;
    }
    if let Some(tools) = &input.tools {
        let allowed = ["read", "bash", "edit", "write", "grep", "find", "ls"];
        let unique = tools.iter().collect::<HashSet<_>>();
        if tools.len() > 7
            || unique.len() != tools.len()
            || tools.iter().any(|tool| !allowed.contains(&tool.as_str()))
        {
            return Err(AgentError::bad(
                "validation_failed",
                "tools must contain unique supported tool names",
            ));
        }
    }
    Ok(())
}

async fn create_agent(
    State(state): State<AgentsState>,
    body: Bytes,
) -> Result<(StatusCode, Json<Value>), AgentError> {
    let input: CreateAgent = decode(&body)?;
    validate_agent_request(&input)?;
    let cwd = allowed_directory(
        &state.runtime,
        input.cwd.as_deref().unwrap_or_else(|| {
            state
                .runtime
                .config
                .launch_config
                .workspace_path
                .to_str()
                .unwrap_or(".")
        }),
    )?
    .to_string_lossy()
    .into_owned();
    let id = Uuid::new_v4().to_string();
    let created_id = id.clone();
    let now = now_iso();
    let model_provider = input.model.as_ref().map(|model| model.provider.clone());
    let model_id = input.model.as_ref().map(|model| model.id.clone());
    let tools = input
        .tools
        .map(|tools| serde_json::to_string(&tools).unwrap_or_default());
    state.runtime.store.with_connection(move |connection| connection.execute("INSERT INTO agent_profiles(id,name,system_prompt,system_prompt_mode,cwd,tools_json,model_provider,model_id,thinking_level,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)", params![created_id,input.name.unwrap_or_else(|| "Agent".to_owned()),input.system_prompt,input.system_prompt_mode.unwrap_or_else(|| "append".to_owned()),cwd,tools,model_provider,model_id,input.thinking_level,now,now])).map_err(AgentError::storage)?;
    let agent = find_agent(&state.runtime.store, &id)?;
    publish_event(
        &state,
        &agent.id,
        None,
        "supervisor.agent_created",
        json!({ "agent": agent }),
    )?;
    Ok((StatusCode::CREATED, Json(json!(agent))))
}

async fn list_agents(
    State(state): State<AgentsState>,
    Query(query): Query<ListQuery>,
) -> Result<Json<Value>, AgentError> {
    let limit = list_limit(&query)?;
    let cursor = decode_cursor(query.cursor.as_deref())?;
    let mut agents = state
        .runtime
        .store
        .with_connection(move |connection| {
            let mut sql = format!("{AGENT_SELECT} WHERE deleted_at IS NULL");
            let mut values = Vec::new();
            if let Some((timestamp, id)) = cursor {
                sql.push_str(" AND (updated_at<? OR (updated_at=? AND id<?))");
                values.extend([timestamp.clone(), timestamp, id]);
            }
            sql.push_str(&format!(
                " ORDER BY updated_at DESC,id DESC LIMIT {}",
                limit + 1
            ));
            let mut statement = connection.prepare(&sql)?;
            statement
                .query_map(rusqlite::params_from_iter(values), agent_from_row)?
                .collect::<rusqlite::Result<Vec<_>>>()
        })
        .map_err(AgentError::storage)?;
    let has_more = agents.len() > limit;
    agents.truncate(limit);
    let next_cursor = has_more
        .then(|| {
            agents
                .last()
                .map(|agent| encode_cursor(&agent.updated_at, &agent.id))
        })
        .flatten();
    Ok(Json(json!({ "agents": agents, "nextCursor": next_cursor })))
}
async fn get_agent(
    State(state): State<AgentsState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, AgentError> {
    Ok(Json(json!(find_agent(&state.runtime.store, &id)?)))
}

async fn update_agent(
    State(state): State<AgentsState>,
    Path(id): Path<String>,
    body: Bytes,
) -> Result<Json<Value>, AgentError> {
    let input: Value = decode(&body)?;
    let object = input
        .as_object()
        .ok_or_else(|| AgentError::bad("validation_failed", "Agent update must be an object"))?;
    let allowed = ["name", "systemPrompt", "systemPromptMode", "tools"];
    if object.is_empty() || object.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(AgentError::bad(
            "validation_failed",
            "Agent update contains no fields or unsupported fields",
        ));
    }
    let current = find_agent(&state.runtime.store, &id)?;
    let name = match object.get("name") {
        Some(Value::String(name)) => {
            validate_text(name.trim(), 256, "name")?;
            name.trim().to_owned()
        }
        Some(_) => {
            return Err(AgentError::bad(
                "validation_failed",
                "name must be a string",
            ));
        }
        None => current.name,
    };
    let system_prompt = match object.get("systemPrompt") {
        Some(Value::String(prompt)) => {
            validate_text(prompt, 250_000, "systemPrompt")?;
            prompt.clone()
        }
        Some(_) => {
            return Err(AgentError::bad(
                "validation_failed",
                "systemPrompt must be a string",
            ));
        }
        None => current.system_prompt,
    };
    let mode = match object.get("systemPromptMode") {
        Some(Value::String(mode)) if matches!(mode.as_str(), "append" | "replace") => mode.clone(),
        Some(_) => {
            return Err(AgentError::bad(
                "validation_failed",
                "systemPromptMode must be append or replace",
            ));
        }
        None => current.system_prompt_mode,
    };
    let tools = if let Some(value) = object.get("tools") {
        if value.is_null() {
            None
        } else {
            let tools = serde_json::from_value::<Vec<String>>(value.clone()).map_err(|_| {
                AgentError::bad("validation_failed", "tools must be an array of tool names")
            })?;
            let allowed = ["read", "bash", "edit", "write", "grep", "find", "ls"];
            let unique = tools.iter().collect::<HashSet<_>>();
            if tools.len() > 7
                || unique.len() != tools.len()
                || tools.iter().any(|tool| !allowed.contains(&tool.as_str()))
            {
                return Err(AgentError::bad(
                    "validation_failed",
                    "tools must contain unique supported tool names",
                ));
            }
            Some(serde_json::to_string(&tools).map_err(AgentError::storage)?)
        }
    } else {
        current
            .tools
            .map(|value| serde_json::to_string(&value).unwrap_or_default())
    };
    let update_id = id.clone();
    state.runtime.store.with_connection(move |connection| connection.execute("UPDATE agent_profiles SET name=?,system_prompt=?,system_prompt_mode=?,tools_json=?,updated_at=? WHERE id=?", params![name,system_prompt,mode,tools,now_iso(),update_id])).map_err(AgentError::storage)?;
    Ok(Json(json!(find_agent(&state.runtime.store, &id)?)))
}
async fn delete_agent(
    State(state): State<AgentsState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, AgentError> {
    let agent = find_agent(&state.runtime.store, &id)?;
    let delete_id = id.clone();
    state
        .runtime
        .store
        .with_connection(move |connection| {
            connection.execute(
                "UPDATE agent_profiles SET deleted_at=?,updated_at=? WHERE id=?",
                params![now_iso(), now_iso(), delete_id],
            )
        })
        .map_err(AgentError::storage)?;
    Ok(Json(json!(agent)))
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Attachment {
    name: String,
    mime_type: String,
    data: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateRun {
    agent_id: String,
    prompt: String,
    model: Option<ModelRef>,
    thinking_level: Option<String>,
    cwd: Option<String>,
    attachments: Option<Vec<Attachment>>,
    execution_mode: Option<String>,
    worktree_id: Option<String>,
    parent_run_id: Option<String>,
    idempotency_key: Option<String>,
}

fn validate_run_request(input: &CreateRun) -> Result<(), AgentError> {
    if Uuid::parse_str(&input.agent_id).is_err() {
        return Err(AgentError::bad(
            "validation_failed",
            "agentId must be a UUID",
        ));
    }
    validate_text(&input.prompt, 1_000_000, "prompt")?;
    if let Some(cwd) = &input.cwd {
        validate_text(cwd.trim(), 4_096, "cwd")?;
    }
    if let Some(model) = &input.model {
        validate_model(model)?;
    }
    if let Some(level) = &input.thinking_level {
        validate_thinking_level(level)?;
    }
    match input.execution_mode.as_deref().unwrap_or("local") {
        "local" if input.worktree_id.is_some() => {
            return Err(AgentError::bad(
                "validation_failed",
                "Local execution cannot reference a worktree",
            ));
        }
        "local" => {}
        "worktree" => {
            return Err(AgentError::conflict(
                "agent_not_available",
                "Worktree execution is not enabled in the unified host",
            ));
        }
        _ => {
            return Err(AgentError::bad(
                "validation_failed",
                "executionMode must be local or worktree",
            ));
        }
    }
    if let Some(parent) = &input.parent_run_id
        && Uuid::parse_str(parent).is_err()
    {
        return Err(AgentError::bad(
            "validation_failed",
            "parentRunId must be a UUID",
        ));
    }
    if let Some(key) = &input.idempotency_key {
        validate_idempotency_key(key)?;
    }
    let attachments = input.attachments.as_deref().unwrap_or_default();
    if attachments.len() > 4 {
        return Err(AgentError::bad(
            "validation_failed",
            "A run accepts at most four image attachments",
        ));
    }
    for attachment in attachments {
        validate_text(attachment.name.trim(), 256, "attachment name")?;
        if !matches!(
            attachment.mime_type.as_str(),
            "image/png" | "image/jpeg" | "image/gif" | "image/webp"
        ) {
            return Err(AgentError::bad(
                "validation_failed",
                "Unsupported image attachment type",
            ));
        }
        if attachment.data.len() > 8_000_000 || BASE64.decode(&attachment.data).is_err() {
            return Err(AgentError::bad(
                "validation_failed",
                "Attachment data must be valid base64 within the size limit",
            ));
        }
    }
    Ok(())
}

async fn create_run(
    State(state): State<AgentsState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<(StatusCode, Json<Value>), AgentError> {
    let request_value: Value = decode(&body)?;
    let input: CreateRun = decode(&body)?;
    validate_run_request(&input)?;
    let agent = find_agent(&state.runtime.store, &input.agent_id)?;
    let receipt = begin_receipt(
        &state.runtime.store,
        idempotency_key(&headers, &request_value),
        &agent.id,
        "run_create",
        &agent.id,
        &request_value,
    )?;
    if let Some(admission) = &receipt
        && let Some(mut replay) = admission.replay.clone()
    {
        if let Value::Object(fields) = &mut replay {
            fields.insert("acknowledgementId".to_owned(), json!(admission.id));
        }
        return Ok((StatusCode::ACCEPTED, Json(replay)));
    }

    let result = create_run_admitted(state.clone(), agent, input).await;
    match result {
        Ok(mut run) => {
            let mut value = json!(run);
            if let Some(admission) = receipt {
                complete_receipt(&state.runtime.store, &admission.id, &value)?;
                run.acknowledgement_id = Some(admission.id);
                value = json!(run);
            }
            Ok((StatusCode::ACCEPTED, Json(value)))
        }
        Err(error) => {
            if let Some(admission) = receipt {
                fail_receipt(&state.runtime.store, &admission.id, &error);
            }
            Err(error)
        }
    }
}

async fn create_run_admitted(
    state: AgentsState,
    agent: Agent,
    input: CreateRun,
) -> Result<Run, AgentError> {
    if active_run_for_agent(&state.runtime.store, &agent.id)?.is_some() {
        return Err(AgentError::conflict(
            "agent_busy",
            "Agent already has an active run",
        ));
    }
    if let Some(parent_run_id) = &input.parent_run_id {
        find_run(&state.runtime.store, parent_run_id)?;
    }
    let cwd = allowed_directory(&state.runtime, input.cwd.as_deref().unwrap_or(&agent.cwd))?
        .to_string_lossy()
        .into_owned();
    let model = input.model.or(agent.model.clone());
    let thinking = input.thinking_level.or(agent.thinking_level.clone());
    let id = Uuid::new_v4().to_string();
    let created_id = id.clone();
    let now = now_iso();
    let provider = model.as_ref().map(|model| model.provider.clone());
    let model_id = model.as_ref().map(|model| model.id.clone());
    let attachments = input.attachments.unwrap_or_default();
    let launch_attachments = attachments.clone();
    let prompt = input.prompt;
    let command_prompt = prompt.clone();
    let agent_id = agent.id.clone();
    let insertion = state.runtime.store.with_connection(move |connection| {
        let transaction = connection.transaction()?;
        transaction.execute("INSERT INTO agent_runs(id,agent_id,prompt,model_provider,model_id,thinking_level,cwd,execution_mode,worktree_id,parent_run_id,status,created_at,started_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", params![created_id,agent_id,prompt,provider,model_id,thinking,cwd,input.execution_mode.unwrap_or_else(|| "local".to_owned()),input.worktree_id,input.parent_run_id,"running",now,now])?;
        for (position, attachment) in attachments.into_iter().enumerate() { transaction.execute("INSERT INTO agent_run_attachments(run_id,position,name,mime_type,data) VALUES(?,?,?,?,?)", params![created_id,i64::try_from(position).unwrap_or(i64::MAX),attachment.name,attachment.mime_type,attachment.data])?; }
        transaction.commit()
    });
    if let Err(error) = insertion {
        if error.to_string().contains("agent_runs.agent_id") {
            return Err(AgentError::conflict(
                "agent_busy",
                "Agent already has an active run",
            ));
        }
        return Err(AgentError::storage(error));
    }
    publish_event(
        &state,
        &agent.id,
        Some(&id),
        "supervisor.prompt_accepted",
        json!({ "prompt": command_prompt }),
    )?;
    let run = find_run(&state.runtime.store, &id)?;
    spawn_pi(
        state.clone(),
        agent,
        run.clone(),
        command_prompt,
        launch_attachments,
    )
    .await;
    find_run(&state.runtime.store, &id)
}

async fn spawn_pi(
    state: AgentsState,
    agent: Agent,
    run: Run,
    prompt: String,
    attachments: Vec<Attachment>,
) {
    let mut command =
        Command::new(std::env::var("PI_EXECUTABLE").unwrap_or_else(|_| "pi".to_owned()));
    command
        .arg("--mode")
        .arg("rpc")
        .arg("--session-dir")
        .arg(state.runtime.config.data_dir.join("pi-sessions"));
    if agent.system_prompt_mode == "replace" {
        command.arg("--system-prompt").arg(&agent.system_prompt);
    } else {
        command
            .arg("--append-system-prompt")
            .arg(&agent.system_prompt);
    }
    if let Some(model) = &run.model {
        command
            .arg("--provider")
            .arg(&model.provider)
            .arg("--model")
            .arg(&model.id);
    }
    if let Some(level) = &run.thinking_level {
        command.arg("--thinking").arg(level);
    }
    if let Some(tools) = &agent.tools {
        command.arg("--tools").arg(tools.join(","));
    }
    command
        .current_dir(&run.cwd)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            fail_run(&state, &run.id, "agent_start_failed", &error.to_string());
            return;
        }
    };
    let Some(stdin) = child.stdin.take() else {
        fail_run(
            &state,
            &run.id,
            "agent_start_failed",
            "Pi stdin unavailable",
        );
        return;
    };
    let Some(stdout) = child.stdout.take() else {
        fail_run(
            &state,
            &run.id,
            "agent_start_failed",
            "Pi stdout unavailable",
        );
        return;
    };
    let stdin = Arc::new(AsyncMutex::new(stdin));
    lock(&state.active).insert(run.id.clone(), Arc::clone(&stdin));
    let images = attachments
        .into_iter()
        .map(|attachment| {
            json!({
                "type": "image",
                "data": attachment.data,
                "mimeType": attachment.mime_type,
            })
        })
        .collect::<Vec<_>>();
    let request = json!({
        "id": Uuid::new_v4().to_string(),
        "type": "prompt",
        "message": prompt,
        "images": images,
    });
    if write_command(&stdin, &request).await.is_err() {
        fail_run(
            &state,
            &run.id,
            "agent_start_failed",
            "Could not send prompt to Pi",
        );
        return;
    }
    let reader_state = state.clone();
    let reader_run = run.id.clone();
    let reader_agent = agent.id.clone();
    tokio::spawn(async move {
        let mut reader = BufReader::new(stdout);
        loop {
            let read = tokio::select! {
                read = read_bounded_json_line(&mut reader) => Some(read),
                () = tokio::time::sleep(Duration::from_millis(250)) => None,
            };
            let Some(read) = read else {
                if reader_state.runtime.is_shutting_down() {
                    let _ = child.start_kill();
                    break;
                }
                continue;
            };
            match read {
                Ok(None) => break,
                Ok(Some(buffer)) => {
                    let Ok(value) = serde_json::from_slice::<Value>(&buffer) else {
                        continue;
                    };
                    let kind = value
                        .get("type")
                        .and_then(Value::as_str)
                        .unwrap_or("pi.event")
                        .to_owned();
                    if kind == "response" {
                        if value.get("success").and_then(Value::as_bool) == Some(false) {
                            let command = value
                                .get("command")
                                .and_then(Value::as_str)
                                .unwrap_or("unknown");
                            let message = value
                                .get("error")
                                .and_then(Value::as_str)
                                .unwrap_or("Pi rejected the command");
                            let _ = publish_event(
                                &reader_state,
                                &reader_agent,
                                Some(&reader_run),
                                "supervisor.command_failed",
                                json!({ "command": command, "message": message }),
                            );
                            if command == "prompt" {
                                fail_run(&reader_state, &reader_run, "agent_start_failed", message);
                                let _ = child.start_kill();
                                break;
                            }
                        }
                        continue;
                    }
                    let mut payload = value.clone();
                    if let Value::Object(fields) = &mut payload {
                        fields.remove("type");
                    }
                    let _ = publish_event(
                        &reader_state,
                        &reader_agent,
                        Some(&reader_run),
                        &kind,
                        payload,
                    );
                    if kind == "agent_settled" {
                        complete_run(&reader_state, &reader_run);
                    }
                }
                Err(_) => {
                    let _ = child.start_kill();
                    break;
                }
            }
        }
        lock(&reader_state.active).remove(&reader_run);
        let _ = child.wait().await;
        if find_run(&reader_state.runtime.store, &reader_run)
            .is_ok_and(|run| run.status == "running")
        {
            fail_run(
                &reader_state,
                &reader_run,
                "agent_process_exited",
                "Pi process exited before settling",
            );
        }
    });
}

async fn read_bounded_json_line<R>(reader: &mut R) -> std::io::Result<Option<Vec<u8>>>
where
    R: AsyncBufRead + Unpin,
{
    const MAX_EVENT_BYTES: usize = 256 * 1_024;
    let mut output = Vec::new();
    let mut overflowed = false;
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            if overflowed {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "Pi event exceeds 256 KiB",
                ));
            }
            return Ok((!output.is_empty()).then_some(output));
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let consumed = newline.map_or(available.len(), |position| position + 1);
        let content = newline.unwrap_or(available.len());
        if !overflowed && output.len().saturating_add(content) <= MAX_EVENT_BYTES {
            output.extend_from_slice(&available[..content]);
        } else {
            overflowed = true;
        }
        reader.consume(consumed);
        if newline.is_some() {
            if overflowed {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "Pi event exceeds 256 KiB",
                ));
            }
            if output.last() == Some(&b'\r') {
                output.pop();
            }
            return Ok(Some(output));
        }
    }
}

async fn write_command(stdin: &Arc<AsyncMutex<ChildStdin>>, value: &Value) -> std::io::Result<()> {
    let mut stdin = stdin.lock().await;
    stdin
        .write_all(serde_json::to_string(value)?.as_bytes())
        .await?;
    stdin.write_all(b"\n").await?;
    stdin.flush().await
}

async fn list_runs(
    State(state): State<AgentsState>,
    Query(query): Query<ListQuery>,
) -> Result<Json<Value>, AgentError> {
    let limit = list_limit(&query)?;
    if let Some(agent_id) = &query.agent_id
        && Uuid::parse_str(agent_id).is_err()
    {
        return Err(AgentError::bad(
            "validation_failed",
            "agentId must be a UUID",
        ));
    }
    if let Some(status) = &query.status
        && !matches!(
            status.as_str(),
            "queued" | "running" | "completed" | "failed" | "cancelled"
        )
    {
        return Err(AgentError::bad(
            "validation_failed",
            "Run status is invalid",
        ));
    }
    let cursor = decode_cursor(query.cursor.as_deref())?;
    let agent_filter = query.agent_id;
    let status_filter = query.status;
    let mut runs = state
        .runtime
        .store
        .with_connection(move |connection| {
            let mut sql = format!("{RUN_SELECT} WHERE 1=1");
            let mut values = Vec::new();
            if let Some(agent_id) = agent_filter {
                sql.push_str(" AND r.agent_id=?");
                values.push(agent_id);
            }
            if let Some(status) = status_filter {
                sql.push_str(" AND r.status=?");
                values.push(status);
            }
            if let Some((timestamp, id)) = cursor {
                sql.push_str(" AND (r.created_at<? OR (r.created_at=? AND r.id<?))");
                values.extend([timestamp.clone(), timestamp, id]);
            }
            sql.push_str(&format!(
                " GROUP BY r.id ORDER BY r.created_at DESC,r.id DESC LIMIT {}",
                limit + 1
            ));
            let mut statement = connection.prepare(&sql)?;
            statement
                .query_map(rusqlite::params_from_iter(values), run_from_row)?
                .collect::<rusqlite::Result<Vec<_>>>()
        })
        .map_err(AgentError::storage)?;
    let has_more = runs.len() > limit;
    runs.truncate(limit);
    let next_cursor = has_more
        .then(|| {
            runs.last()
                .map(|run| encode_cursor(&run.created_at, &run.id))
        })
        .flatten();
    Ok(Json(json!({ "runs": runs, "nextCursor": next_cursor })))
}
async fn get_run(
    State(state): State<AgentsState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, AgentError> {
    Ok(Json(json!(find_run(&state.runtime.store, &id)?)))
}

async fn cancel_run(
    State(state): State<AgentsState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<Value>, AgentError> {
    let request_value = if body.is_empty() {
        json!({})
    } else {
        decode::<Value>(&body)?
    };
    let run = find_run(&state.runtime.store, &id)?;
    let receipt = begin_receipt(
        &state.runtime.store,
        idempotency_key(&headers, &request_value),
        &run.agent_id,
        "cancel",
        &id,
        &request_value,
    )?;
    if let Some(admission) = &receipt
        && let Some(mut replay) = admission.replay.clone()
    {
        if let Value::Object(fields) = &mut replay {
            fields.insert("acknowledgementId".to_owned(), json!(admission.id));
        }
        return Ok(Json(replay));
    }
    if !matches!(run.status.as_str(), "queued" | "running") {
        let error = AgentError::conflict("run_not_cancellable", "Run is not cancellable");
        if let Some(admission) = receipt {
            fail_receipt(&state.runtime.store, &admission.id, &error);
        }
        return Err(error);
    }
    let stdin = lock(&state.active).get(&id).cloned().ok_or_else(|| {
        AgentError::conflict(
            "agent_not_available",
            "Run is not attached to a live Pi process",
        )
    })?;
    write_command(&stdin, &json!({"type":"abort"}))
        .await
        .map_err(AgentError::storage)?;
    update_run_status(&state, &id, "cancelled", None, None);
    publish_event(
        &state,
        &run.agent_id,
        Some(&id),
        "supervisor.run_cancelled",
        json!({}),
    )?;
    let mut result = json!(find_run(&state.runtime.store, &id)?);
    if let Some(admission) = receipt {
        complete_receipt(&state.runtime.store, &admission.id, &result)?;
        if let Value::Object(fields) = &mut result {
            fields.insert("acknowledgementId".to_owned(), json!(admission.id));
        }
    }
    Ok(Json(result))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MessageInput {
    message: String,
    attachments: Option<Vec<Attachment>>,
    idempotency_key: Option<String>,
}

async fn steer_run(
    State(state): State<AgentsState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<(StatusCode, Json<Value>), AgentError> {
    send_run_message(state, id, headers, body, "steer").await
}
async fn follow_up_run(
    State(state): State<AgentsState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<(StatusCode, Json<Value>), AgentError> {
    send_run_message(state, id, headers, body, "follow_up").await
}
async fn send_run_message(
    state: AgentsState,
    id: String,
    headers: HeaderMap,
    body: Bytes,
    kind: &str,
) -> Result<(StatusCode, Json<Value>), AgentError> {
    let request_value: Value = decode(&body)?;
    let input: MessageInput = decode(&body)?;
    validate_text(&input.message, 1_000_000, "message")?;
    if let Some(key) = &input.idempotency_key {
        validate_idempotency_key(key)?;
    }
    let attachments = input.attachments.as_deref().unwrap_or_default();
    if attachments.len() > 4 {
        return Err(AgentError::bad(
            "validation_failed",
            "A message accepts at most four image attachments",
        ));
    }
    for attachment in attachments {
        validate_text(attachment.name.trim(), 256, "attachment name")?;
        if !matches!(
            attachment.mime_type.as_str(),
            "image/png" | "image/jpeg" | "image/gif" | "image/webp"
        ) || attachment.data.len() > 8_000_000
            || BASE64.decode(&attachment.data).is_err()
        {
            return Err(AgentError::bad(
                "validation_failed",
                "Message attachment is invalid",
            ));
        }
    }
    let run = find_run(&state.runtime.store, &id)?;
    let receipt = begin_receipt(
        &state.runtime.store,
        idempotency_key(&headers, &request_value),
        &run.agent_id,
        kind,
        &id,
        &request_value,
    )?;
    if let Some(admission) = &receipt
        && let Some(mut replay) = admission.replay.clone()
    {
        if let Value::Object(fields) = &mut replay {
            fields.insert("acknowledgementId".to_owned(), json!(admission.id));
        }
        return Ok((StatusCode::ACCEPTED, Json(replay)));
    }
    let stdin = lock(&state.active).get(&id).cloned().ok_or_else(|| {
        AgentError::conflict(
            "agent_not_available",
            "Run is not attached to a live Pi process",
        )
    })?;
    let images = input
        .attachments
        .unwrap_or_default()
        .into_iter()
        .map(|attachment| {
            json!({
                "type": "image",
                "data": attachment.data,
                "mimeType": attachment.mime_type,
            })
        })
        .collect::<Vec<_>>();
    if let Err(error) = write_command(
        &stdin,
        &json!({ "type": kind, "message": input.message, "images": images }),
    )
    .await
    .map_err(AgentError::storage)
    {
        if let Some(admission) = receipt {
            fail_receipt(&state.runtime.store, &admission.id, &error);
        }
        return Err(error);
    }
    publish_event(
        &state,
        &run.agent_id,
        Some(&id),
        "supervisor.message_queued",
        json!({ "kind": kind }),
    )?;
    let mut result = json!(find_run(&state.runtime.store, &id)?);
    if let Some(admission) = receipt {
        complete_receipt(&state.runtime.store, &admission.id, &result)?;
        if let Value::Object(fields) = &mut result {
            fields.insert("acknowledgementId".to_owned(), json!(admission.id));
        }
    }
    Ok((StatusCode::ACCEPTED, Json(result)))
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct EventsQuery {
    after_sequence: Option<i64>,
    before_sequence: Option<i64>,
    limit: Option<i64>,
    ticket: Option<String>,
}
async fn agent_events(
    State(state): State<AgentsState>,
    Path(agent_id): Path<String>,
    Query(query): Query<EventsQuery>,
) -> Result<Json<Value>, AgentError> {
    event_page(&state.runtime.store, Some(agent_id), None, query)
}
async fn run_events(
    State(state): State<AgentsState>,
    Path(run_id): Path<String>,
    Query(query): Query<EventsQuery>,
) -> Result<Json<Value>, AgentError> {
    event_page(&state.runtime.store, None, Some(run_id), query)
}
fn event_page(
    store: &StateStore,
    agent_id: Option<String>,
    run_id: Option<String>,
    query: EventsQuery,
) -> Result<Json<Value>, AgentError> {
    let after = query.after_sequence.unwrap_or(0);
    let before = query.before_sequence;
    let limit = query.limit.unwrap_or(100);
    if !(1..=500).contains(&limit) || after < 0 || before.is_some_and(|value| value < 1) {
        return Err(AgentError::bad(
            "validation_failed",
            "Event cursor or page limit is invalid",
        ));
    }
    let descending = before.is_some();
    let events = store.with_connection(move |connection| {
        let (column, id) = if let Some(id) = agent_id {
            ("agent_id", id)
        } else {
            ("run_id", run_id.unwrap_or_default())
        };
        let comparison = if descending { "sequence<?" } else { "sequence>?" };
        let order = if descending { "DESC" } else { "ASC" };
        let sql = format!("SELECT json_object('agentId',agent_id,'runId',run_id,'sequence',sequence,'type',event_type,'payload',json(payload_json),'createdAt',created_at) FROM agent_events WHERE {column}=? AND {comparison} ORDER BY sequence {order} LIMIT ?");
        let cursor = before.unwrap_or(after);
        let mut statement = connection.prepare(&sql)?;
        statement
            .query_map(params![id, cursor, limit + 1], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()
    }).map_err(AgentError::storage)?;
    let has_more = i64::try_from(events.len()).unwrap_or(i64::MAX) > limit;
    let mut values = events
        .into_iter()
        .take(usize::try_from(limit).unwrap_or(100))
        .filter_map(|value| serde_json::from_str::<Value>(&value).ok())
        .collect::<Vec<_>>();
    if descending {
        values.reverse();
    }
    let first = values
        .first()
        .and_then(|value| value.get("sequence"))
        .and_then(Value::as_i64);
    let last = values
        .last()
        .and_then(|value| value.get("sequence"))
        .and_then(Value::as_i64);
    Ok(Json(json!({
        "events": values,
        "nextSequence": (!descending && has_more).then_some(last).flatten(),
        "previousSequence": (descending && has_more).then_some(first).flatten(),
        "hasMore": has_more,
    })))
}

async fn run_stream(
    ws: WebSocketUpgrade,
    State(state): State<AgentsState>,
    Path(id): Path<String>,
    Query(query): Query<EventsQuery>,
    headers: HeaderMap,
) -> Response {
    stream_admission(ws, state, None, Some(id), query, headers).await
}
async fn agent_stream(
    ws: WebSocketUpgrade,
    State(state): State<AgentsState>,
    Path(id): Path<String>,
    Query(query): Query<EventsQuery>,
    headers: HeaderMap,
) -> Response {
    stream_admission(ws, state, Some(id), None, query, headers).await
}
async fn stream_admission(
    ws: WebSocketUpgrade,
    state: AgentsState,
    agent_id: Option<String>,
    run_id: Option<String>,
    query: EventsQuery,
    headers: HeaderMap,
) -> Response {
    if query.after_sequence.is_some_and(|sequence| sequence < 0) {
        return AgentError::bad("validation_failed", "afterSequence must be non-negative")
            .into_response();
    }
    const TICKET_TTL: Duration = Duration::from_secs(30);
    let bearer_is_valid = state
        .runtime
        .config
        .auth_token
        .as_ref()
        .is_some_and(|token| {
            let expected = format!("Bearer {token}");
            headers
                .get("authorization")
                .is_some_and(|value| value.as_bytes().ct_eq(expected.as_bytes()).into())
        });
    let admitted = bearer_is_valid
        || query.ticket.as_ref().is_some_and(|ticket| {
            lock(&state.tickets)
                .remove(ticket)
                .is_some_and(|created_at| created_at.elapsed() <= TICKET_TTL)
        })
        || state.runtime.config.auth_token.is_none();
    if !admitted {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let resource_exists = if let Some(id) = agent_id.as_deref() {
        find_agent(&state.runtime.store, id).map(|_| ())
    } else if let Some(id) = run_id.as_deref() {
        find_run(&state.runtime.store, id).map(|_| ())
    } else {
        Err(AgentError::not_found(
            "not_found",
            "Event stream was not found",
        ))
    };
    if let Err(error) = resource_exists {
        return error.into_response();
    }
    let Ok(permit) = Arc::clone(&state.stream_limit).try_acquire_owned() else {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    };
    ws.on_upgrade(move |socket| async move {
        let _permit = permit;
        stream_events(
            socket,
            state,
            agent_id,
            run_id,
            query.after_sequence.unwrap_or(0),
        )
        .await;
    })
}
async fn stream_events(
    mut socket: WebSocket,
    state: AgentsState,
    agent_id: Option<String>,
    run_id: Option<String>,
    after: i64,
) {
    // Subscribe before replaying the database so an event committed during the
    // replay window is either in the page or buffered by the receiver.
    let mut receiver = state.events.subscribe();
    let mut last_sequence = after;
    loop {
        let page = event_page(
            &state.runtime.store,
            agent_id.clone(),
            run_id.clone(),
            EventsQuery {
                after_sequence: Some(last_sequence),
                limit: Some(500),
                ..EventsQuery::default()
            },
        );
        let Ok(Json(value)) = page else { return };
        let Some(events) = value.get("events").and_then(Value::as_array) else {
            return;
        };
        for event in events {
            let Some(sequence) = event.get("sequence").and_then(Value::as_i64) else {
                return;
            };
            if sequence <= last_sequence {
                continue;
            }
            if socket
                .send(Message::Text(event.to_string().into()))
                .await
                .is_err()
            {
                return;
            }
            last_sequence = sequence;
        }
        if !value
            .get("hasMore")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            break;
        }
    }
    loop {
        tokio::select! {
            incoming = socket.next() => if incoming.is_none() { break; },
            event = receiver.recv() => match event {
                Ok(event) if (agent_id.as_ref().is_some_and(|id| id == &event.agent_id) || run_id.as_ref().is_some_and(|id| event.run_id.as_ref() == Some(id))) && event.value.get("sequence").and_then(Value::as_i64).is_some_and(|sequence| sequence > last_sequence) => {
                    if socket.send(Message::Text(event.value.to_string().into())).await.is_err() { break; }
                    if let Some(sequence) = event.value.get("sequence").and_then(Value::as_i64) { last_sequence = sequence; }
                },
                Ok(_) => {},
                Err(_) => break,
            }
        }
    }
}

async fn run_attachments(
    State(state): State<AgentsState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, AgentError> {
    find_run(&state.runtime.store, &id)?;
    let attachments = state.runtime.store.with_connection(move |connection| { let mut statement=connection.prepare("SELECT json_object('name',name,'mimeType',mime_type,'data',data) FROM agent_run_attachments WHERE run_id=? ORDER BY position")?; statement.query_map([id],|row| row.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>() }).map_err(AgentError::storage)?.into_iter().filter_map(|value|serde_json::from_str::<Value>(&value).ok()).collect::<Vec<_>>();
    Ok(Json(json!({"attachments":attachments})))
}
async fn run_debug_log(
    State(state): State<AgentsState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, AgentError> {
    let run = find_run(&state.runtime.store, &id)?;
    let Json(events) = event_page(
        &state.runtime.store,
        None,
        Some(id.clone()),
        EventsQuery {
            limit: Some(500),
            ..EventsQuery::default()
        },
    )?;
    Ok(Json(
        json!({"runId":id,"sessionId":null,"sessionFile":null,"available":false,"unavailableReason":"Pi RPC journals are managed by Pi","content":"","bytesRead":0,"fileSize":null,"truncated":false,"diagnostics":[],"supervisorEvents":events.get("events").cloned().unwrap_or_else(||json!([])),"status":run.status}),
    ))
}
async fn run_changes(
    State(state): State<AgentsState>,
    Path(id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Json<Value>, AgentError> {
    let run = find_run(&state.runtime.store, &id)?;
    let scope = query
        .get("scope")
        .cloned()
        .unwrap_or_else(|| "working_tree".to_owned());
    let output = Command::new("git")
        .args(["diff", "--no-ext-diff", "--"])
        .current_dir(&run.cwd)
        .output()
        .await;
    let (available, patch, reason) = match output {
        Ok(output) if output.status.success() => (
            true,
            String::from_utf8_lossy(&output.stdout).into_owned(),
            Value::Null,
        ),
        Ok(output) => (
            false,
            String::new(),
            json!(String::from_utf8_lossy(&output.stderr).into_owned()),
        ),
        Err(error) => (false, String::new(), json!(error.to_string())),
    };
    Ok(Json(
        json!({"runId":id,"scope":scope,"available":available,"unavailableReason":reason,"baseRef":null,"files":[],"patch":patch,"truncated":false}),
    ))
}

async fn fleet(State(state): State<AgentsState>) -> Result<Json<Value>, AgentError> {
    let runs = state
        .runtime
        .store
        .with_connection(|connection| {
            let mut statement = connection.prepare(&format!(
                "{RUN_SELECT} GROUP BY r.id ORDER BY r.created_at DESC, r.id DESC"
            ))?;
            statement
                .query_map([], run_from_row)?
                .collect::<rusqlite::Result<Vec<_>>>()
        })
        .map_err(AgentError::storage)?;
    let agent_names = state
        .runtime
        .store
        .with_connection(|connection| {
            let mut statement = connection.prepare("SELECT id,name FROM agent_profiles")?;
            statement
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<rusqlite::Result<HashMap<_, _>>>()
        })
        .map_err(AgentError::storage)?;
    let active = runs
        .iter()
        .filter(|run| matches!(run.status.as_str(), "queued" | "running"))
        .count();
    let attention = runs.iter().filter(|run| run.status == "failed").count();
    let total = runs.len();
    let mut children: HashMap<Option<String>, Vec<Run>> = HashMap::new();
    for run in runs {
        children
            .entry(run.parent_run_id.clone())
            .or_default()
            .push(run);
    }
    let roots = fleet_children(None, &mut children, &agent_names);
    Ok(Json(json!({
        "health": {
            "status": "healthy",
            "database": "connected",
            "runtime": if state.runtime.is_shutting_down() { "stopping" } else { "ready" },
            "checkedAt": now_iso(),
        },
        "runs": roots,
        "counts": { "active": active, "attention": attention, "total": total },
        "complete": true,
    })))
}

fn fleet_children(
    parent_id: Option<String>,
    runs: &mut HashMap<Option<String>, Vec<Run>>,
    agent_names: &HashMap<String, String>,
) -> Vec<Value> {
    runs.remove(&parent_id)
        .unwrap_or_default()
        .into_iter()
        .map(|run| {
            let child_runs = fleet_children(Some(run.id.clone()), runs, agent_names);
            json!({
                "id": run.id,
                "parentRunId": run.parent_run_id,
                "agentId": run.agent_id,
                "agentName": agent_names.get(&run.agent_id).cloned().unwrap_or_else(|| "Deleted agent".to_owned()),
                "prompt": run.prompt,
                "cwd": run.cwd,
                "status": run.status,
                "executionMode": run.execution_mode,
                "worktreeId": run.worktree_id,
                "createdAt": run.created_at,
                "startedAt": run.started_at,
                "completedAt": run.completed_at,
                "children": child_runs,
            })
        })
        .collect()
}
async fn empty_worktrees() -> Json<Value> {
    Json(json!({"worktrees":[]}))
}
async fn empty_terminal_sessions() -> Json<Value> {
    Json(json!({"sessions":[]}))
}
async fn worktrees_unavailable() -> AgentError {
    AgentError::bad(
        "agent_not_available",
        "Worktrees are not enabled in the unified host",
    )
}
async fn terminal_unavailable() -> AgentError {
    AgentError::bad(
        "agent_not_available",
        "Use the /terminal namespace for persistent terminals",
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateInbox {
    kind: String,
    run_id: Option<String>,
    title: String,
    body: Option<String>,
    options: Option<Vec<String>>,
}
async fn create_inbox(
    State(state): State<AgentsState>,
    body: Bytes,
) -> Result<(StatusCode, Json<Value>), AgentError> {
    let input: CreateInbox = decode(&body)?;
    let id = Uuid::new_v4().to_string();
    let created = id.clone();
    state.runtime.store.with_connection(move|connection|connection.execute("INSERT INTO agent_inbox(id,kind,run_id,title,body,options_json,status,created_at) VALUES(?,?,?,?,?,?,?,?)",params![created,input.kind,input.run_id,input.title,input.body.unwrap_or_default(),serde_json::to_string(&input.options.unwrap_or_default()).unwrap_or_else(|_|"[]".to_owned()),"pending",now_iso()])).map_err(AgentError::storage)?;
    Ok((
        StatusCode::CREATED,
        Json(find_inbox(&state.runtime.store, &id)?),
    ))
}
async fn list_inbox(State(state): State<AgentsState>) -> Result<Json<Value>, AgentError> {
    let items=state.runtime.store.with_connection(|connection|{let mut statement=connection.prepare("SELECT json_object('id',id,'kind',kind,'runId',run_id,'title',title,'body',body,'options',json(options_json),'status',status,'response',response,'createdAt',created_at,'resolvedAt',resolved_at) FROM agent_inbox ORDER BY created_at DESC")?;statement.query_map([],|row|row.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()}).map_err(AgentError::storage)?.into_iter().filter_map(|value|serde_json::from_str(&value).ok()).collect::<Vec<Value>>();
    Ok(Json(json!({"items":items})))
}
#[derive(Deserialize)]
struct ResolveInbox {
    response: String,
}
async fn resolve_inbox(
    State(state): State<AgentsState>,
    Path(id): Path<String>,
    body: Bytes,
) -> Result<Json<Value>, AgentError> {
    let input: ResolveInbox = decode(&body)?;
    let update = id.clone();
    state
        .runtime
        .store
        .with_connection(move |connection| {
            connection.execute(
                "UPDATE agent_inbox SET status='resolved',response=?,resolved_at=? WHERE id=?",
                params![input.response, now_iso(), update],
            )
        })
        .map_err(AgentError::storage)?;
    Ok(Json(find_inbox(&state.runtime.store, &id)?))
}
async fn cancel_inbox(
    State(state): State<AgentsState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, AgentError> {
    let update = id.clone();
    state
        .runtime
        .store
        .with_connection(move |connection| {
            connection.execute(
                "UPDATE agent_inbox SET status='cancelled',resolved_at=? WHERE id=?",
                params![now_iso(), update],
            )
        })
        .map_err(AgentError::storage)?;
    Ok(Json(find_inbox(&state.runtime.store, &id)?))
}
#[derive(Deserialize)]
struct SearchQuery {
    q: String,
    limit: Option<usize>,
}
async fn search_sessions(
    State(state): State<AgentsState>,
    Query(query): Query<SearchQuery>,
) -> Result<Json<Value>, AgentError> {
    let needle = format!("%{}%", query.q);
    let limit = i64::try_from(query.limit.unwrap_or(30).min(100)).unwrap_or(30);
    let results=state.runtime.store.with_connection(move|connection|{let mut statement=connection.prepare("SELECT json_object('runId',r.id,'agentId',r.agent_id,'title',r.prompt,'cwd',r.cwd,'status',r.status,'createdAt',r.created_at) FROM agent_runs r JOIN agent_profiles a ON a.id=r.agent_id WHERE r.prompt LIKE ? OR a.name LIKE ? ORDER BY r.created_at DESC LIMIT ?")?;statement.query_map(params![needle,needle,limit],|row|row.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()}).map_err(AgentError::storage)?.into_iter().filter_map(|value|serde_json::from_str(&value).ok()).collect::<Vec<Value>>();
    Ok(Json(json!({"results":results})))
}

fn find_agent(store: &StateStore, id: &str) -> Result<Agent, AgentError> {
    let id = id.to_owned();
    store
        .with_connection(move |connection| {
            connection
                .query_row(
                    &format!("{AGENT_SELECT} WHERE id=? AND deleted_at IS NULL"),
                    [id],
                    agent_from_row,
                )
                .optional()
        })
        .map_err(AgentError::storage)?
        .ok_or_else(|| AgentError::not_found("not_found", "Agent was not found"))
}
fn find_run(store: &StateStore, id: &str) -> Result<Run, AgentError> {
    let id = id.to_owned();
    store
        .with_connection(move |connection| {
            connection
                .query_row(
                    &format!("{RUN_SELECT} WHERE r.id=? GROUP BY r.id"),
                    [id],
                    run_from_row,
                )
                .optional()
        })
        .map_err(AgentError::storage)?
        .ok_or_else(|| AgentError::not_found("not_found", "Run was not found"))
}
fn find_project(store: &StateStore, id: &str) -> Result<Value, AgentError> {
    let id = id.to_owned();
    let encoded=store.with_connection(move|connection|connection.query_row("SELECT json_object('id',id,'name',name,'path',path,'createdAt',created_at,'updatedAt',updated_at,'lastUsedAt',last_used_at) FROM agent_projects WHERE id=?",[id],|row|row.get::<_,String>(0)).optional()).map_err(AgentError::storage)?.ok_or_else(||AgentError::not_found("not_found","Project was not found"))?;
    serde_json::from_str(&encoded).map_err(AgentError::storage)
}
fn find_inbox(store: &StateStore, id: &str) -> Result<Value, AgentError> {
    let id = id.to_owned();
    let encoded=store.with_connection(move|connection|connection.query_row("SELECT json_object('id',id,'kind',kind,'runId',run_id,'title',title,'body',body,'options',json(options_json),'status',status,'response',response,'createdAt',created_at,'resolvedAt',resolved_at) FROM agent_inbox WHERE id=?",[id],|row|row.get::<_,String>(0)).optional()).map_err(AgentError::storage)?.ok_or_else(||AgentError::not_found("not_found","Inbox item was not found"))?;
    serde_json::from_str(&encoded).map_err(AgentError::storage)
}
fn active_run_for_agent(store: &StateStore, agent_id: &str) -> Result<Option<String>, AgentError> {
    let id = agent_id.to_owned();
    store.with_connection(move|connection|connection.query_row("SELECT id FROM agent_runs WHERE agent_id=? AND status IN ('queued','running') LIMIT 1",[id],|row|row.get(0)).optional()).map_err(AgentError::storage)
}
fn publish_event(
    state: &AgentsState,
    agent_id: &str,
    run_id: Option<&str>,
    event_type: &str,
    payload: Value,
) -> Result<(), AgentError> {
    let agent = agent_id.to_owned();
    let run = run_id.map(str::to_owned);
    let kind = event_type.to_owned();
    let payload_json = serde_json::to_string(&payload).map_err(AgentError::storage)?;
    let created = now_iso();
    let result=state.runtime.store.with_connection({let agent=agent.clone();let run=run.clone();let kind=kind.clone();let created=created.clone();move|connection|{let transaction=connection.transaction()?;let sequence:i64=transaction.query_row("SELECT COALESCE(MAX(sequence),0)+1 FROM agent_events WHERE agent_id=?",[&agent],|row|row.get(0))?;transaction.execute("INSERT INTO agent_events(agent_id,run_id,sequence,event_type,payload_json,created_at) VALUES(?,?,?,?,?,?)",params![agent,run,sequence,kind,payload_json,created])?;transaction.commit()?;Ok(sequence)}}).map_err(AgentError::storage)?;
    let value = json!({"agentId":agent,"runId":run,"sequence":result,"type":kind,"payload":payload,"createdAt":created});
    let _ = state.events.send(AgentEventEnvelope {
        agent_id: agent,
        run_id: run,
        value,
    });
    Ok(())
}
fn complete_run(state: &AgentsState, id: &str) {
    update_run_status(state, id, "completed", None, None)
}
fn fail_run(state: &AgentsState, id: &str, code: &str, message: &str) {
    update_run_status(state, id, "failed", Some(code), Some(message))
}
fn update_run_status(
    state: &AgentsState,
    id: &str,
    status: &str,
    code: Option<&str>,
    message: Option<&str>,
) {
    let id = id.to_owned();
    let status = status.to_owned();
    let code = code.map(str::to_owned);
    let message = message.map(str::to_owned);
    let _ = state.runtime.store.with_connection(move |connection| {
        connection.execute(
            "UPDATE agent_runs SET status=?,error_code=?,error_message=?,completed_at=? WHERE id=?",
            params![status, code, message, now_iso(), id],
        )
    });
}
fn request_hash(command: &str, resource_id: &str, body: &Value) -> Result<String, AgentError> {
    let encoded = serde_json::to_vec(&json!({
        "command": command,
        "resourceId": resource_id,
        "body": body,
    }))
    .map_err(AgentError::storage)?;
    Ok(format!("{:x}", Sha256::digest(encoded)))
}

fn idempotency_key<'a>(headers: &'a HeaderMap, body: &'a Value) -> Option<&'a str> {
    body.get("idempotencyKey")
        .and_then(Value::as_str)
        .or_else(|| {
            headers
                .get("idempotency-key")
                .and_then(|value| value.to_str().ok())
        })
}

fn validate_idempotency_key(key: &str) -> Result<(), AgentError> {
    if key.is_empty()
        || key.len() > 256
        || !key
            .as_bytes()
            .iter()
            .all(|byte| (0x21..=0x7e).contains(byte))
    {
        return Err(AgentError::bad(
            "validation_failed",
            "idempotencyKey must contain 1 to 256 visible ASCII characters",
        ));
    }
    Ok(())
}

fn begin_receipt(
    store: &StateStore,
    key: Option<&str>,
    agent_id: &str,
    command: &str,
    resource_id: &str,
    body: &Value,
) -> Result<Option<ReceiptAdmission>, AgentError> {
    let Some(key) = key else { return Ok(None) };
    validate_idempotency_key(key)?;
    let hash = request_hash(command, resource_id, body)?;
    let candidate_id = Uuid::new_v4().to_string();
    let key = key.to_owned();
    let agent_id = agent_id.to_owned();
    let command = command.to_owned();
    let created_at = now_iso();
    let inserted_id = candidate_id.clone();
    let inserted_key = key.clone();
    let inserted_agent_id = agent_id.clone();
    let inserted_command = command.clone();
    let inserted_hash = hash.clone();
    let receipt = store
        .with_connection(move |connection| {
            connection.execute(
                "INSERT OR IGNORE INTO agent_command_receipts(id,idempotency_key,agent_id,command,request_hash,status,created_at,updated_at) VALUES(?,?,?,?,?,'pending',?,?)",
                params![inserted_id, inserted_key, inserted_agent_id, inserted_command, inserted_hash, created_at, created_at],
            )?;
            connection.query_row(
                "SELECT id,agent_id,command,request_hash,status,result_json,error_code,error_message,created_at,updated_at,completed_at FROM agent_command_receipts WHERE idempotency_key=?",
                [key],
                |row| {
                    let result: Option<String> = row.get(5)?;
                    Ok(ReceiptRow {
                        id: row.get(0)?,
                        agent_id: row.get(1)?,
                        command: row.get(2)?,
                        request_hash: row.get(3)?,
                        status: row.get(4)?,
                        result: result.and_then(|value| serde_json::from_str(&value).ok()),
                        error_code: row.get(6)?,
                        error_message: row.get(7)?,
                        created_at: row.get(8)?,
                        updated_at: row.get(9)?,
                        completed_at: row.get(10)?,
                    })
                },
            )
        })
        .map_err(AgentError::storage)?;
    if receipt.agent_id != agent_id || receipt.command != command || receipt.request_hash != hash {
        return Err(AgentError::conflict(
            "idempotency_conflict",
            "Idempotency key was already used for a different request",
        ));
    }
    match receipt.status.as_str() {
        "pending" if receipt.id == candidate_id => Ok(Some(ReceiptAdmission {
            id: receipt.id,
            replay: None,
        })),
        "pending" => Err(AgentError::conflict(
            "idempotency_in_progress",
            "The command for this idempotency key is still in progress",
        )),
        "succeeded" => Ok(Some(ReceiptAdmission {
            id: receipt.id,
            replay: receipt.result,
        })),
        "failed" => Err(stored_receipt_error(
            receipt.error_code.as_deref(),
            receipt.error_message.as_deref(),
        )),
        _ => Err(AgentError::conflict(
            "command_outcome_unknown",
            "The outcome of this command is unknown",
        )),
    }
}

fn complete_receipt(store: &StateStore, id: &str, result: &Value) -> Result<(), AgentError> {
    let id = id.to_owned();
    let result = serde_json::to_string(result).map_err(AgentError::storage)?;
    let now = now_iso();
    store
        .with_connection(move |connection| {
            connection.execute(
                "UPDATE agent_command_receipts SET status='succeeded',result_json=?,error_code=NULL,error_message=NULL,updated_at=?,completed_at=? WHERE id=? AND status='pending'",
                params![result, now, now, id],
            )
        })
        .map(|_| ())
        .map_err(AgentError::storage)
}

fn fail_receipt(store: &StateStore, id: &str, error: &AgentError) {
    let id = id.to_owned();
    let code = error.code.to_owned();
    let message = error.message.clone();
    let now = now_iso();
    let _ = store.with_connection(move |connection| {
        connection.execute(
            "UPDATE agent_command_receipts SET status='failed',error_code=?,error_message=?,updated_at=?,completed_at=? WHERE id=? AND status='pending'",
            params![code, message, now, now, id],
        )
    });
}

fn stored_receipt_error(code: Option<&str>, message: Option<&str>) -> AgentError {
    let code = match code {
        Some("validation_failed") => "validation_failed",
        Some("not_authenticated") => "not_authenticated",
        Some("not_authorized") => "not_authorized",
        Some("not_found") => "not_found",
        Some("idempotency_conflict") => "idempotency_conflict",
        Some("idempotency_in_progress") => "idempotency_in_progress",
        Some("command_outcome_unknown") => "command_outcome_unknown",
        Some("invalid_state_transition") => "invalid_state_transition",
        Some("run_not_cancellable") => "run_not_cancellable",
        Some("agent_not_available") => "agent_not_available",
        Some("agent_busy") => "agent_busy",
        Some("payload_too_large") => "payload_too_large",
        _ => "internal_error",
    };
    AgentError {
        status: match code {
            "validation_failed" => StatusCode::BAD_REQUEST,
            "not_authenticated" => StatusCode::UNAUTHORIZED,
            "not_authorized" => StatusCode::FORBIDDEN,
            "not_found" => StatusCode::NOT_FOUND,
            "internal_error" => StatusCode::INTERNAL_SERVER_ERROR,
            _ => StatusCode::CONFLICT,
        },
        code,
        message: message.unwrap_or("The command failed").to_owned(),
    }
}

async fn command_receipt(
    State(state): State<AgentsState>,
    Path(key): Path<String>,
) -> Result<Json<Value>, AgentError> {
    validate_idempotency_key(&key)?;
    let lookup_key = key.clone();
    let receipt = state
        .runtime
        .store
        .with_connection(move |connection| {
            connection
                .query_row(
                    "SELECT id,agent_id,command,request_hash,status,result_json,error_code,error_message,created_at,updated_at,completed_at FROM agent_command_receipts WHERE idempotency_key=?",
                    [lookup_key],
                    |row| {
                        let result: Option<String> = row.get(5)?;
                        Ok(ReceiptRow {
                            id: row.get(0)?,
                            agent_id: row.get(1)?,
                            command: row.get(2)?,
                            request_hash: row.get(3)?,
                            status: row.get(4)?,
                            result: result.and_then(|value| serde_json::from_str(&value).ok()),
                            error_code: row.get(6)?,
                            error_message: row.get(7)?,
                            created_at: row.get(8)?,
                            updated_at: row.get(9)?,
                            completed_at: row.get(10)?,
                        })
                    },
                )
                .optional()
        })
        .map_err(AgentError::storage)?
        .ok_or_else(|| AgentError::not_found("not_found", "Command receipt was not found"))?;
    Ok(Json(json!({
        "id": receipt.id,
        "idempotencyKey": key,
        "agentId": receipt.agent_id,
        "command": receipt.command,
        "status": receipt.status,
        "result": receipt.result,
        "error": receipt.error_code.map(|code| json!({
            "code": code,
            "message": receipt.error_message.unwrap_or_else(|| "The command failed".to_owned()),
        })),
        "createdAt": receipt.created_at,
        "updatedAt": receipt.updated_at,
        "completedAt": receipt.completed_at,
    })))
}

fn reconcile_runs(store: &StateStore) -> Result<(), AgentError> {
    store.with_connection(|connection|connection.execute("UPDATE agent_runs SET status='failed',error_code='host_restarted',error_message='The unified host restarted',completed_at=? WHERE status IN ('queued','running')",[now_iso()])).map(|_|()).map_err(AgentError::storage)
}

fn reconcile_receipts(store: &StateStore) -> Result<(), AgentError> {
    store
        .with_connection(|connection| {
            connection.execute(
                "UPDATE agent_command_receipts SET status='indeterminate',error_code='command_outcome_unknown',error_message='The host restarted before the command outcome was recorded',updated_at=?,completed_at=? WHERE status='pending'",
                params![now_iso(), now_iso()],
            )
        })
        .map(|_| ())
        .map_err(AgentError::storage)
}

fn decode<T: DeserializeOwned>(body: &[u8]) -> Result<T, AgentError> {
    serde_json::from_slice(body)
        .map_err(|_| AgentError::bad("validation_failed", "Request body must be valid JSON"))
}
fn allowed_directory(runtime: &HostRuntime, value: &str) -> Result<PathBuf, AgentError> {
    let path = if value == "~" {
        runtime.home_dir.clone().into()
    } else {
        PathBuf::from(value)
    };
    let path = if path.is_absolute() {
        path
    } else {
        runtime.config.launch_config.workspace_path.join(path)
    };
    let canonical = path
        .canonicalize()
        .map_err(|_| AgentError::bad("validation_failed", "Working directory does not exist"))?;
    if !canonical.is_dir() || !path_allowed(&canonical, &runtime.config.allowed_roots) {
        return Err(AgentError::bad(
            "validation_failed",
            "Working directory is outside allowed roots",
        ));
    }
    Ok(canonical)
}
fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}
