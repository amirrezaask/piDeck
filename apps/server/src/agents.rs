use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use axum::{
    Json, Router,
    body::Bytes,
    extract::{
        Path, Query, State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, patch, post},
};
use futures_util::StreamExt as _;
use rusqlite::{OptionalExtension, Row, params};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt as _, AsyncWriteExt as _, BufReader},
    process::{ChildStdin, Command},
    sync::{Mutex as AsyncMutex, broadcast},
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

#[derive(Clone)]
struct AgentsState {
    runtime: Arc<HostRuntime>,
    active: Arc<Mutex<HashMap<String, Arc<AsyncMutex<ChildStdin>>>>>,
    tickets: Arc<Mutex<HashMap<String, Instant>>>,
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
    let (events, _) = broadcast::channel(1_024);
    let state = AgentsState {
        runtime,
        active: Arc::new(Mutex::new(HashMap::new())),
        tickets: Arc::new(Mutex::new(HashMap::new())),
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
        .with_state::<S>(state))
}

#[derive(Debug)]
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
struct ModelRef {
    provider: String,
    id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Run {
    id: String,
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

async fn health() -> Json<Value> {
    Json(json!({ "status": "ok", "service": "agents" }))
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

async fn models() -> Json<Value> {
    Json(json!({ "models": [], "defaultModel": null }))
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
struct CreateProject {
    path: String,
    name: Option<String>,
}
async fn create_project(
    State(state): State<AgentsState>,
    body: Bytes,
) -> Result<(StatusCode, Json<Value>), AgentError> {
    let input: CreateProject = decode(&body)?;
    let path = allowed_directory(&state.runtime, &input.path)?;
    let canonical = path.to_string_lossy().into_owned();
    let requested_name = input.name.clone();
    let name = input
        .name
        .filter(|value| !value.trim().is_empty())
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

async fn list_projects(State(state): State<AgentsState>) -> Result<Json<Value>, AgentError> {
    let projects = state.runtime.store.with_connection(|connection| {
        let mut statement = connection.prepare("SELECT json_object('id',id,'name',name,'path',path,'createdAt',created_at,'updatedAt',updated_at,'lastUsedAt',last_used_at) FROM agent_projects ORDER BY last_used_at DESC")?;
        statement.query_map([], |row| row.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()
    }).map_err(AgentError::storage)?.into_iter().filter_map(|value| serde_json::from_str::<Value>(&value).ok()).collect::<Vec<_>>();
    Ok(Json(json!({ "projects": projects, "nextCursor": null })))
}

async fn update_project(
    State(state): State<AgentsState>,
    Path(id): Path<String>,
    body: Bytes,
) -> Result<Json<Value>, AgentError> {
    let input: Value = decode(&body)?;
    let current = find_project(&state.runtime.store, &id)?;
    let name = input
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_else(|| {
            current
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("Project")
        })
        .trim()
        .to_owned();
    let requested_path = input
        .get("path")
        .and_then(Value::as_str)
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
#[serde(rename_all = "camelCase")]
struct CreateAgent {
    name: Option<String>,
    system_prompt: String,
    system_prompt_mode: Option<String>,
    cwd: Option<String>,
    tools: Option<Vec<String>>,
    model: Option<ModelRef>,
    thinking_level: Option<String>,
}
async fn create_agent(
    State(state): State<AgentsState>,
    body: Bytes,
) -> Result<(StatusCode, Json<Value>), AgentError> {
    let input: CreateAgent = decode(&body)?;
    if input.system_prompt.is_empty() {
        return Err(AgentError::bad(
            "validation_failed",
            "systemPrompt is required",
        ));
    }
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

async fn list_agents(State(state): State<AgentsState>) -> Result<Json<Value>, AgentError> {
    let agents = state
        .runtime
        .store
        .with_connection(|connection| {
            let mut statement = connection.prepare(&format!(
                "{AGENT_SELECT} WHERE deleted_at IS NULL ORDER BY updated_at DESC"
            ))?;
            statement
                .query_map([], agent_from_row)?
                .collect::<rusqlite::Result<Vec<_>>>()
        })
        .map_err(AgentError::storage)?;
    Ok(Json(json!({ "agents": agents, "nextCursor": null })))
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
    let current = find_agent(&state.runtime.store, &id)?;
    let name = input
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or(&current.name)
        .trim()
        .to_owned();
    let system_prompt = input
        .get("systemPrompt")
        .and_then(Value::as_str)
        .unwrap_or(&current.system_prompt)
        .to_owned();
    let mode = input
        .get("systemPromptMode")
        .and_then(Value::as_str)
        .unwrap_or(&current.system_prompt_mode)
        .to_owned();
    let tools = if let Some(value) = input.get("tools") {
        if value.is_null() {
            None
        } else {
            Some(serde_json::to_string(value).map_err(AgentError::storage)?)
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Attachment {
    name: String,
    mime_type: String,
    data: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
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
}

async fn create_run(
    State(state): State<AgentsState>,
    body: Bytes,
) -> Result<(StatusCode, Json<Value>), AgentError> {
    let input: CreateRun = decode(&body)?;
    if input.prompt.is_empty() {
        return Err(AgentError::bad("validation_failed", "prompt is required"));
    }
    let agent = find_agent(&state.runtime.store, &input.agent_id)?;
    if active_run_for_agent(&state.runtime.store, &agent.id)?.is_some() {
        return Err(AgentError::conflict(
            "agent_busy",
            "Agent already has an active run",
        ));
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
    let prompt = input.prompt;
    let command_prompt = prompt.clone();
    let agent_id = agent.id.clone();
    state.runtime.store.with_connection(move |connection| {
        let transaction = connection.transaction()?;
        transaction.execute("INSERT INTO agent_runs(id,agent_id,prompt,model_provider,model_id,thinking_level,cwd,execution_mode,worktree_id,parent_run_id,status,created_at,started_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", params![created_id,agent_id,prompt,provider,model_id,thinking,cwd,input.execution_mode.unwrap_or_else(|| "local".to_owned()),input.worktree_id,input.parent_run_id,"running",now,now])?;
        for (position, attachment) in attachments.into_iter().enumerate() { transaction.execute("INSERT INTO agent_run_attachments(run_id,position,name,mime_type,data) VALUES(?,?,?,?,?)", params![created_id,i64::try_from(position).unwrap_or(i64::MAX),attachment.name,attachment.mime_type,attachment.data])?; }
        transaction.commit()
    }).map_err(AgentError::storage)?;
    publish_event(
        &state,
        &agent.id,
        Some(&id),
        "supervisor.prompt_accepted",
        json!({ "prompt": command_prompt }),
    )?;
    spawn_pi(state.clone(), agent, id.clone(), command_prompt).await;
    Ok((
        StatusCode::ACCEPTED,
        Json(json!(find_run(&state.runtime.store, &id)?)),
    ))
}

async fn spawn_pi(state: AgentsState, agent: Agent, run_id: String, prompt: String) {
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
    if let Some(model) = &agent.model {
        command
            .arg("--provider")
            .arg(&model.provider)
            .arg("--model")
            .arg(&model.id);
    }
    if let Some(level) = &agent.thinking_level {
        command.arg("--thinking").arg(level);
    }
    if let Some(tools) = &agent.tools {
        command.arg("--tools").arg(tools.join(","));
    }
    command
        .current_dir(&agent.cwd)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            fail_run(&state, &run_id, "agent_start_failed", &error.to_string());
            return;
        }
    };
    let Some(stdin) = child.stdin.take() else {
        fail_run(
            &state,
            &run_id,
            "agent_start_failed",
            "Pi stdin unavailable",
        );
        return;
    };
    let Some(stdout) = child.stdout.take() else {
        fail_run(
            &state,
            &run_id,
            "agent_start_failed",
            "Pi stdout unavailable",
        );
        return;
    };
    let stdin = Arc::new(AsyncMutex::new(stdin));
    lock(&state.active).insert(run_id.clone(), Arc::clone(&stdin));
    let request = json!({ "id": Uuid::new_v4().to_string(), "type": "prompt", "message": prompt });
    if write_command(&stdin, &request).await.is_err() {
        fail_run(
            &state,
            &run_id,
            "agent_start_failed",
            "Could not send prompt to Pi",
        );
        return;
    }
    let reader_state = state.clone();
    let reader_run = run_id.clone();
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
                    if kind != "response" {
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
                    }
                    if kind == "agent_settled" {
                        complete_run(&reader_state, &reader_run);
                    } else if kind == "agent_end"
                        && !value
                            .get("willRetry")
                            .and_then(Value::as_bool)
                            .unwrap_or(false)
                    {
                        let _ = publish_event(
                            &reader_state,
                            &reader_agent,
                            Some(&reader_run),
                            "agent_settled",
                            json!({}),
                        );
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
    Query(query): Query<HashMap<String, String>>,
) -> Result<Json<Value>, AgentError> {
    let agent_filter = query.get("agentId").cloned();
    let status_filter = query.get("status").cloned();
    let runs = state
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
            sql.push_str(" GROUP BY r.id ORDER BY r.created_at DESC LIMIT 500");
            let mut statement = connection.prepare(&sql)?;
            statement
                .query_map(rusqlite::params_from_iter(values), run_from_row)?
                .collect::<rusqlite::Result<Vec<_>>>()
        })
        .map_err(AgentError::storage)?;
    Ok(Json(json!({ "runs": runs, "nextCursor": null })))
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
) -> Result<Json<Value>, AgentError> {
    let run = find_run(&state.runtime.store, &id)?;
    let stdin = { lock(&state.active).get(&id).cloned() };
    if let Some(stdin) = stdin {
        let _ = write_command(&stdin, &json!({"type":"abort"})).await;
    }
    update_run_status(&state, &id, "cancelled", None, None);
    publish_event(
        &state,
        &run.agent_id,
        Some(&id),
        "supervisor.run_cancelled",
        json!({}),
    )?;
    Ok(Json(json!(find_run(&state.runtime.store, &id)?)))
}
#[derive(Deserialize)]
struct MessageInput {
    message: String,
}
async fn steer_run(
    State(state): State<AgentsState>,
    Path(id): Path<String>,
    body: Bytes,
) -> Result<(StatusCode, Json<Value>), AgentError> {
    send_run_message(state, id, body, "steer").await
}
async fn follow_up_run(
    State(state): State<AgentsState>,
    Path(id): Path<String>,
    body: Bytes,
) -> Result<(StatusCode, Json<Value>), AgentError> {
    send_run_message(state, id, body, "follow_up").await
}
async fn send_run_message(
    state: AgentsState,
    id: String,
    body: Bytes,
    kind: &str,
) -> Result<(StatusCode, Json<Value>), AgentError> {
    let input: MessageInput = decode(&body)?;
    let run = find_run(&state.runtime.store, &id)?;
    let stdin = lock(&state.active).get(&id).cloned().ok_or_else(|| {
        AgentError::conflict(
            "agent_not_available",
            "Run is not attached to a live Pi process",
        )
    })?;
    write_command(&stdin, &json!({ "type": kind, "message": input.message }))
        .await
        .map_err(AgentError::storage)?;
    publish_event(
        &state,
        &run.agent_id,
        Some(&id),
        "supervisor.message_queued",
        json!({ "kind": kind }),
    )?;
    Ok((
        StatusCode::ACCEPTED,
        Json(json!(find_run(&state.runtime.store, &id)?)),
    ))
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
    let before = query.before_sequence.unwrap_or(i64::MAX);
    let limit = query.limit.unwrap_or(100).clamp(1, 500);
    let events = store.with_connection(move |connection| {
        let (column, id) = if let Some(id) = agent_id { ("agent_id", id) } else { ("run_id", run_id.unwrap_or_default()) };
        let sql = format!("SELECT json_object('agentId',agent_id,'runId',run_id,'sequence',sequence,'type',event_type,'payload',json(payload_json),'createdAt',created_at) FROM agent_events WHERE {column}=? AND sequence>? AND sequence<? ORDER BY sequence ASC LIMIT ?");
        let mut statement = connection.prepare(&sql)?;
        statement.query_map(params![id,after,before,limit+1], |row| row.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()
    }).map_err(AgentError::storage)?;
    let has_more = i64::try_from(events.len()).unwrap_or(i64::MAX) > limit;
    let values = events
        .into_iter()
        .take(usize::try_from(limit).unwrap_or(100))
        .filter_map(|value| serde_json::from_str::<Value>(&value).ok())
        .collect::<Vec<_>>();
    let next = has_more
        .then(|| {
            values
                .last()
                .and_then(|value| value.get("sequence"))
                .and_then(Value::as_i64)
        })
        .flatten();
    Ok(Json(
        json!({ "events": values, "nextSequence": next, "previousSequence": null, "hasMore": has_more }),
    ))
}

async fn run_stream(
    ws: WebSocketUpgrade,
    State(state): State<AgentsState>,
    Path(id): Path<String>,
    Query(query): Query<EventsQuery>,
) -> Response {
    stream_admission(ws, state, None, Some(id), query).await
}
async fn agent_stream(
    ws: WebSocketUpgrade,
    State(state): State<AgentsState>,
    Path(id): Path<String>,
    Query(query): Query<EventsQuery>,
) -> Response {
    stream_admission(ws, state, Some(id), None, query).await
}
async fn stream_admission(
    ws: WebSocketUpgrade,
    state: AgentsState,
    agent_id: Option<String>,
    run_id: Option<String>,
    query: EventsQuery,
) -> Response {
    const TICKET_TTL: Duration = Duration::from_secs(30);
    let admitted = query.ticket.as_ref().is_some_and(|ticket| {
        lock(&state.tickets)
            .remove(ticket)
            .is_some_and(|created_at| created_at.elapsed() <= TICKET_TTL)
    }) || state.runtime.config.auth_token.is_none();
    if !admitted {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    ws.on_upgrade(move |socket| {
        stream_events(
            socket,
            state,
            agent_id,
            run_id,
            query.after_sequence.unwrap_or(0),
        )
    })
}
async fn stream_events(
    mut socket: WebSocket,
    state: AgentsState,
    agent_id: Option<String>,
    run_id: Option<String>,
    after: i64,
) {
    let page = event_page(
        &state.runtime.store,
        agent_id.clone(),
        run_id.clone(),
        EventsQuery {
            after_sequence: Some(after),
            limit: Some(500),
            ..EventsQuery::default()
        },
    );
    if let Ok(Json(value)) = page
        && let Some(events) = value.get("events").and_then(Value::as_array)
    {
        for event in events {
            if socket
                .send(Message::Text(event.to_string().into()))
                .await
                .is_err()
            {
                return;
            }
        }
    }
    let mut receiver = state.events.subscribe();
    loop {
        tokio::select! {
            incoming = socket.next() => if incoming.is_none() { break; },
            event = receiver.recv() => match event {
                Ok(event) if agent_id.as_ref().is_some_and(|id| id == &event.agent_id) || run_id.as_ref().is_some_and(|id| event.run_id.as_ref() == Some(id)) => { if socket.send(Message::Text(event.value.to_string().into())).await.is_err() { break; } },
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
    let Json(value) = list_runs(State(state), Query(HashMap::new())).await?;
    let runs = value
        .get("runs")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let active = runs
        .iter()
        .filter(|run| {
            matches!(
                run.get("status").and_then(Value::as_str),
                Some("queued" | "running")
            )
        })
        .count();
    let attention = runs
        .iter()
        .filter(|run| run.get("status").and_then(Value::as_str) == Some("failed"))
        .count();
    Ok(Json(
        json!({"health":{"status":"healthy","database":"connected","runtime":"ready","checkedAt":now_iso()},"runs":runs,"counts":{"active":active,"attention":attention,"total":runs.len()},"complete":true}),
    ))
}
async fn empty_worktrees() -> Json<Value> {
    Json(json!({"worktrees":[]}))
}
async fn empty_terminal_sessions() -> Json<Value> {
    Json(json!({"sessions":[]}))
}
async fn worktrees_unavailable() -> AgentError {
    AgentError::bad(
        "capability_unavailable",
        "Worktrees are not enabled in the unified host",
    )
}
async fn terminal_unavailable() -> AgentError {
    AgentError::bad(
        "capability_unavailable",
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
        .ok_or_else(|| AgentError::not_found("agent_not_found", "Agent was not found"))
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
        .ok_or_else(|| AgentError::not_found("run_not_found", "Run was not found"))
}
fn find_project(store: &StateStore, id: &str) -> Result<Value, AgentError> {
    let id = id.to_owned();
    let encoded=store.with_connection(move|connection|connection.query_row("SELECT json_object('id',id,'name',name,'path',path,'createdAt',created_at,'updatedAt',updated_at,'lastUsedAt',last_used_at) FROM agent_projects WHERE id=?",[id],|row|row.get::<_,String>(0)).optional()).map_err(AgentError::storage)?.ok_or_else(||AgentError::not_found("project_not_found","Project was not found"))?;
    serde_json::from_str(&encoded).map_err(AgentError::storage)
}
fn find_inbox(store: &StateStore, id: &str) -> Result<Value, AgentError> {
    let id = id.to_owned();
    let encoded=store.with_connection(move|connection|connection.query_row("SELECT json_object('id',id,'kind',kind,'runId',run_id,'title',title,'body',body,'options',json(options_json),'status',status,'response',response,'createdAt',created_at,'resolvedAt',resolved_at) FROM agent_inbox WHERE id=?",[id],|row|row.get::<_,String>(0)).optional()).map_err(AgentError::storage)?.ok_or_else(||AgentError::not_found("inbox_not_found","Inbox item was not found"))?;
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
fn reconcile_runs(store: &StateStore) -> Result<(), AgentError> {
    store.with_connection(|connection|connection.execute("UPDATE agent_runs SET status='failed',error_code='host_restarted',error_message='The unified host restarted',completed_at=? WHERE status IN ('queued','running')",[now_iso()])).map(|_|()).map_err(AgentError::storage)
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
