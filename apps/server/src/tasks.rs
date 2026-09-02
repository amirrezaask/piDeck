use std::{collections::HashSet, sync::Arc};

use axum::{
    Json, Router,
    body::Bytes,
    extract::{Path, RawQuery},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, patch},
};
use rusqlite::{OptionalExtension, Row, params, params_from_iter, types::Value as SqlValue};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::{model::now_iso, store::StateStore};

const MIGRATION: &str = r#"
CREATE TABLE IF NOT EXISTS task_projects (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  key TEXT NOT NULL UNIQUE COLLATE NOCASE,
  description TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '#8b5cf6',
  next_task_number INTEGER NOT NULL DEFAULT 1 CHECK (next_task_number > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS task_labels (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL UNIQUE,
  color TEXT NOT NULL DEFAULT '#71717a',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES task_projects(id) ON DELETE RESTRICT,
  task_number INTEGER NOT NULL,
  identifier TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  description TEXT,
  status TEXT NOT NULL CHECK (status IN ('backlog','todo','in_progress','done','canceled')),
  priority TEXT NOT NULL CHECK (priority IN ('no_priority','urgent','high','medium','low')),
  due_date TEXT,
  sort_order REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(project_id, task_number)
);
CREATE TABLE IF NOT EXISTS task_label_assignments (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  label_id TEXT NOT NULL REFERENCES task_labels(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, label_id)
);
CREATE INDEX IF NOT EXISTS tasks_project_id_idx ON tasks(project_id);
CREATE INDEX IF NOT EXISTS tasks_status_idx ON tasks(status);
CREATE INDEX IF NOT EXISTS tasks_priority_idx ON tasks(priority);
CREATE INDEX IF NOT EXISTS tasks_updated_at_idx ON tasks(updated_at);
CREATE INDEX IF NOT EXISTS tasks_due_date_idx ON tasks(due_date);
CREATE INDEX IF NOT EXISTS task_label_assignments_label_idx ON task_label_assignments(label_id);
"#;

const TASK_SELECT: &str = r#"SELECT
  t.id, t.project_id, t.task_number, t.identifier, t.title, t.description,
  t.status, t.priority, t.due_date, t.sort_order, t.created_at, t.updated_at,
  t.completed_at,
  p.name, p.key, p.description, p.color, p.next_task_number, p.created_at, p.updated_at,
  COALESCE(json_group_array(json_object(
    'id', l.id, 'name', l.name, 'color', l.color, 'createdAt', l.created_at
  )) FILTER (WHERE l.id IS NOT NULL), '[]')
FROM tasks t
JOIN task_projects p ON p.id = t.project_id
LEFT JOIN task_label_assignments tla ON tla.task_id = t.id
LEFT JOIN task_labels l ON l.id = tla.label_id"#;

#[derive(Clone)]
struct TaskState {
    store: Arc<StateStore>,
}

pub(crate) fn router<S>(store: Arc<StateStore>) -> Result<Router<S>, TaskError>
where
    S: Clone + Send + Sync + 'static,
{
    store
        .apply_feature_migration("0100-tasks", MIGRATION)
        .map_err(TaskError::storage)?;
    seed_default_project(&store)?;
    let state = TaskState { store };
    Ok(Router::new()
        .route("/health", get(health))
        .route("/api/projects", get(list_projects).post(create_project))
        .route(
            "/api/projects/{project_id}",
            get(get_project)
                .patch(update_project)
                .delete(delete_project),
        )
        .route("/api/labels", get(list_labels).post(create_label))
        .route(
            "/api/labels/{label_id}",
            patch(update_label).delete(delete_label),
        )
        .route("/api/tasks", get(list_tasks).post(create_task))
        .route(
            "/api/tasks/{task_id}",
            get(get_task).patch(update_task).delete(delete_task),
        )
        .with_state::<S>(state))
}

#[derive(Debug)]
pub(crate) struct TaskError {
    status: StatusCode,
    code: &'static str,
    message: String,
    details: Value,
}

impl TaskError {
    fn bad(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            code,
            message: message.into(),
            details: Value::Null,
        }
    }

    fn not_found(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            code,
            message: message.into(),
            details: Value::Null,
        }
    }

    fn conflict(code: &'static str, message: impl Into<String>, details: Value) -> Self {
        Self {
            status: StatusCode::CONFLICT,
            code,
            message: message.into(),
            details,
        }
    }

    fn storage(error: impl std::fmt::Display) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "DATABASE_ERROR",
            message: "Database operation failed".to_owned(),
            details: json!({ "reason": error.to_string() }),
        }
    }
}

impl std::fmt::Display for TaskError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for TaskError {}

impl IntoResponse for TaskError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(json!({
                "error": { "code": self.code, "message": self.message, "details": self.details }
            })),
        )
            .into_response()
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Project {
    id: String,
    name: String,
    key: String,
    description: String,
    color: String,
    next_task_number: i64,
    created_at: String,
    updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Label {
    id: String,
    name: String,
    color: String,
    created_at: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Task {
    id: String,
    project_id: String,
    task_number: i64,
    identifier: String,
    title: String,
    description: Option<String>,
    status: String,
    priority: String,
    due_date: Option<String>,
    sort_order: f64,
    created_at: String,
    updated_at: String,
    completed_at: Option<String>,
    project: Project,
    labels: Vec<Label>,
}

fn project_from_row(row: &Row<'_>, offset: usize) -> rusqlite::Result<Project> {
    Ok(Project {
        id: row.get(offset)?,
        name: row.get(offset + 1)?,
        key: row.get(offset + 2)?,
        description: row.get(offset + 3)?,
        color: row.get(offset + 4)?,
        next_task_number: row.get(offset + 5)?,
        created_at: row.get(offset + 6)?,
        updated_at: row.get(offset + 7)?,
    })
}

fn label_from_row(row: &Row<'_>) -> rusqlite::Result<Label> {
    Ok(Label {
        id: row.get(0)?,
        name: row.get(1)?,
        color: row.get(2)?,
        created_at: row.get(3)?,
    })
}

fn task_from_row(row: &Row<'_>) -> rusqlite::Result<Task> {
    let labels_json: String = row.get(20)?;
    let labels = serde_json::from_str(&labels_json).unwrap_or_default();
    Ok(Task {
        id: row.get(0)?,
        project_id: row.get(1)?,
        task_number: row.get(2)?,
        identifier: row.get(3)?,
        title: row.get(4)?,
        description: row.get(5)?,
        status: row.get(6)?,
        priority: row.get(7)?,
        due_date: row.get(8)?,
        sort_order: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
        completed_at: row.get(12)?,
        project: Project {
            id: row.get(1)?,
            name: row.get(13)?,
            key: row.get(14)?,
            description: row.get(15)?,
            color: row.get(16)?,
            next_task_number: row.get(17)?,
            created_at: row.get(18)?,
            updated_at: row.get(19)?,
        },
        labels,
    })
}

fn seed_default_project(store: &StateStore) -> Result<(), TaskError> {
    store
        .with_connection(|connection| {
            let count: i64 = connection.query_row("SELECT COUNT(*) FROM task_projects", [], |row| {
                row.get(0)
            })?;
            if count == 0 {
                let now = now_iso();
                connection.execute(
                    "INSERT INTO task_projects(id,name,key,description,color,next_task_number,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?)",
                    params![Uuid::new_v4().to_string(), "Dispatch", "DSP", "", "#8b5cf6", now, now],
                )?;
            }
            Ok(())
        })
        .map_err(TaskError::storage)
}

async fn health(
    axum::extract::State(TaskState { store }): axum::extract::State<TaskState>,
) -> Result<Json<Value>, TaskError> {
    store
        .with_connection(|connection| connection.query_row("SELECT 1", [], |_| Ok(())))
        .map_err(TaskError::storage)?;
    Ok(Json(json!({
        "data": { "service": "tasks", "status": "ok", "timestamp": now_iso() }
    })))
}

async fn list_projects(
    axum::extract::State(state): axum::extract::State<TaskState>,
) -> Result<Json<Value>, TaskError> {
    let projects = state
        .store
        .with_connection(|connection| {
            let mut statement = connection.prepare(
                "SELECT id,name,key,description,color,next_task_number,created_at,updated_at FROM task_projects ORDER BY name COLLATE NOCASE",
            )?;
            statement
                .query_map([], |row| project_from_row(row, 0))?
                .collect::<rusqlite::Result<Vec<Project>>>()
        })
        .map_err(TaskError::storage)?;
    Ok(data(projects))
}

async fn get_project(
    axum::extract::State(state): axum::extract::State<TaskState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, TaskError> {
    Ok(data(find_project(&state.store, &id)?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateProject {
    name: String,
    key: String,
    description: Option<String>,
    color: Option<String>,
}

async fn create_project(
    axum::extract::State(state): axum::extract::State<TaskState>,
    body: Bytes,
) -> Result<Json<Value>, TaskError> {
    let input: CreateProject = decode(&body)?;
    let name = clean_required(
        &input.name,
        "INVALID_PROJECT_NAME",
        "Project name is required",
    )?;
    let key = input.key.trim().to_uppercase();
    if !(2..=8).contains(&key.len()) || !key.bytes().all(|byte| byte.is_ascii_alphanumeric()) {
        return Err(TaskError::bad(
            "INVALID_PROJECT_KEY",
            "Project key must contain 2–8 letters or numbers",
        ));
    }
    let color = input.color.unwrap_or_else(|| "#8b5cf6".to_owned());
    validate_color(&color)?;
    let id = Uuid::new_v4().to_string();
    let created_id = id.clone();
    let now = now_iso();
    let result = state.store.with_connection(move |connection| {
        connection.execute(
            "INSERT INTO task_projects(id,name,key,description,color,next_task_number,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?)",
            params![created_id, name, key, input.description.unwrap_or_default(), color, now, now],
        )
    });
    if let Err(error) = result {
        if error.to_string().contains("UNIQUE constraint failed") {
            return Err(TaskError::conflict(
                "PROJECT_KEY_EXISTS",
                "A project with this key already exists",
                Value::Null,
            ));
        }
        return Err(TaskError::storage(error));
    }
    Ok(data(find_project(&state.store, &id)?))
}

async fn update_project(
    axum::extract::State(state): axum::extract::State<TaskState>,
    Path(id): Path<String>,
    body: Bytes,
) -> Result<Json<Value>, TaskError> {
    let input: Value = decode(&body)?;
    let current = find_project(&state.store, &id)?;
    let name = optional_string(&input, "name")?
        .map(|value| clean_required(&value, "INVALID_PROJECT_NAME", "Project name is required"))
        .transpose()?
        .unwrap_or(current.name);
    let key = optional_string(&input, "key")?
        .map(|value| value.trim().to_uppercase())
        .unwrap_or(current.key);
    if !(2..=8).contains(&key.len()) || !key.bytes().all(|byte| byte.is_ascii_alphanumeric()) {
        return Err(TaskError::bad(
            "INVALID_PROJECT_KEY",
            "Project key must contain 2–8 letters or numbers",
        ));
    }
    let description = optional_string(&input, "description")?.unwrap_or(current.description);
    let color = optional_string(&input, "color")?.unwrap_or(current.color);
    validate_color(&color)?;
    let update_id = id.clone();
    let result = state.store.with_connection(move |connection| {
        connection.execute(
            "UPDATE task_projects SET name=?,key=?,description=?,color=?,updated_at=? WHERE id=?",
            params![name, key, description, color, now_iso(), update_id],
        )
    });
    if let Err(error) = result {
        if error.to_string().contains("UNIQUE constraint failed") {
            return Err(TaskError::conflict(
                "PROJECT_KEY_EXISTS",
                "A project with this key already exists",
                Value::Null,
            ));
        }
        return Err(TaskError::storage(error));
    }
    Ok(data(find_project(&state.store, &id)?))
}

async fn delete_project(
    axum::extract::State(state): axum::extract::State<TaskState>,
    Path(id): Path<String>,
    RawQuery(query): RawQuery,
) -> Result<Json<Value>, TaskError> {
    let cascade = query.as_deref().is_some_and(|query| {
        url::form_urlencoded::parse(query.as_bytes())
            .any(|(key, value)| key == "cascade" && value == "true")
    });
    let delete_id = id.clone();
    let result = state
        .store
        .with_connection(move |connection| {
            let count: i64 = connection.query_row(
                "SELECT COUNT(*) FROM tasks WHERE project_id=?",
                [&delete_id],
                |row| row.get(0),
            )?;
            if count > 0 && !cascade {
                return Ok((false, count, true));
            }
            let transaction = connection.transaction()?;
            if cascade {
                transaction.execute("DELETE FROM tasks WHERE project_id=?", [&delete_id])?;
            }
            let removed =
                transaction.execute("DELETE FROM task_projects WHERE id=?", [&delete_id])? > 0;
            transaction.commit()?;
            Ok((removed, count, false))
        })
        .map_err(TaskError::storage)?;
    if result.2 {
        return Err(TaskError::conflict(
            "PROJECT_HAS_TASKS",
            "Project still contains tasks",
            json!({"taskCount": result.1}),
        ));
    }
    if !result.0 {
        return Err(TaskError::not_found(
            "PROJECT_NOT_FOUND",
            "Project was not found",
        ));
    }
    Ok(data(Value::Null))
}

async fn list_labels(
    axum::extract::State(state): axum::extract::State<TaskState>,
) -> Result<Json<Value>, TaskError> {
    let labels = state
        .store
        .with_connection(|connection| {
            let mut statement = connection.prepare(
                "SELECT id,name,color,created_at FROM task_labels ORDER BY name COLLATE NOCASE",
            )?;
            statement
                .query_map([], label_from_row)?
                .collect::<rusqlite::Result<Vec<Label>>>()
        })
        .map_err(TaskError::storage)?;
    Ok(data(labels))
}

#[derive(Deserialize)]
struct CreateLabel {
    name: String,
    color: Option<String>,
}

async fn create_label(
    axum::extract::State(state): axum::extract::State<TaskState>,
    body: Bytes,
) -> Result<Json<Value>, TaskError> {
    let input: CreateLabel = decode(&body)?;
    let name = clean_required(&input.name, "INVALID_LABEL_NAME", "Label name is required")?;
    let color = input.color.unwrap_or_else(|| "#71717a".to_owned());
    validate_color(&color)?;
    let id = Uuid::new_v4().to_string();
    let created_id = id.clone();
    let normalized = name.to_lowercase();
    let result = state.store.with_connection(move |connection| {
        connection.execute(
            "INSERT INTO task_labels(id,name,normalized_name,color,created_at) VALUES(?,?,?,?,?)",
            params![created_id, name, normalized, color, now_iso()],
        )
    });
    if let Err(error) = result {
        if error.to_string().contains("UNIQUE constraint failed") {
            return Err(TaskError::conflict(
                "LABEL_NAME_EXISTS",
                "A label with this name already exists",
                Value::Null,
            ));
        }
        return Err(TaskError::storage(error));
    }
    Ok(data(find_label(&state.store, &id)?))
}

async fn update_label(
    axum::extract::State(state): axum::extract::State<TaskState>,
    Path(id): Path<String>,
    body: Bytes,
) -> Result<Json<Value>, TaskError> {
    let input: Value = decode(&body)?;
    let current = find_label(&state.store, &id)?;
    let name = optional_string(&input, "name")?
        .map(|value| clean_required(&value, "INVALID_LABEL_NAME", "Label name is required"))
        .transpose()?
        .unwrap_or(current.name);
    let color = optional_string(&input, "color")?.unwrap_or(current.color);
    validate_color(&color)?;
    let update_id = id.clone();
    let normalized = name.to_lowercase();
    let result = state.store.with_connection(move |connection| {
        connection.execute(
            "UPDATE task_labels SET name=?,normalized_name=?,color=? WHERE id=?",
            params![name, normalized, color, update_id],
        )
    });
    if let Err(error) = result {
        if error.to_string().contains("UNIQUE constraint failed") {
            return Err(TaskError::conflict(
                "LABEL_NAME_EXISTS",
                "A label with this name already exists",
                Value::Null,
            ));
        }
        return Err(TaskError::storage(error));
    }
    Ok(data(find_label(&state.store, &id)?))
}

async fn delete_label(
    axum::extract::State(state): axum::extract::State<TaskState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, TaskError> {
    let removed = state
        .store
        .with_connection(move |connection| {
            connection.execute("DELETE FROM task_labels WHERE id=?", [id])
        })
        .map_err(TaskError::storage)?;
    if removed == 0 {
        return Err(TaskError::not_found(
            "LABEL_NOT_FOUND",
            "Label was not found",
        ));
    }
    Ok(data(Value::Null))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateTask {
    project_id: String,
    title: String,
    description: Option<String>,
    status: Option<String>,
    priority: Option<String>,
    due_date: Option<String>,
    label_ids: Option<Vec<String>>,
}

async fn create_task(
    axum::extract::State(state): axum::extract::State<TaskState>,
    body: Bytes,
) -> Result<Json<Value>, TaskError> {
    let input: CreateTask = decode(&body)?;
    let title = clean_required(&input.title, "INVALID_TASK_TITLE", "Task title is required")?;
    let status = input.status.unwrap_or_else(|| "backlog".to_owned());
    let priority = input.priority.unwrap_or_else(|| "no_priority".to_owned());
    validate_status(&status)?;
    validate_priority(&priority)?;
    validate_due_date(input.due_date.as_deref())?;
    let labels = deduplicate(input.label_ids.unwrap_or_default());
    let id = Uuid::new_v4().to_string();
    let created_id = id.clone();
    let now = now_iso();
    let completed = (status == "done").then(|| now.clone());
    let result = state.store.with_connection(move |connection| {
        let transaction = connection.transaction()?;
        let project = transaction.query_row(
            "UPDATE task_projects SET next_task_number=next_task_number+1,updated_at=? WHERE id=? RETURNING key,next_task_number-1",
            params![now, input.project_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        ).optional()?;
        let Some((key, task_number)) = project else {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        };
        transaction.execute(
            "INSERT INTO tasks(id,project_id,task_number,identifier,title,description,status,priority,due_date,sort_order,created_at,updated_at,completed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
            params![created_id, input.project_id, task_number, format!("{key}-{task_number}"), title, input.description, status, priority, input.due_date, now_millis(), now, now, completed],
        )?;
        replace_labels(&transaction, &created_id, &labels)?;
        transaction.commit()
    });
    if let Err(error) = result {
        if matches!(error, crate::store::StoreError::Storage(ref message) if message.contains("Query returned no rows"))
        {
            return Err(TaskError::not_found(
                "PROJECT_NOT_FOUND",
                "Project was not found",
            ));
        }
        return Err(map_foreign_key(error));
    }
    Ok(data(find_task(&state.store, &id)?))
}

async fn get_task(
    axum::extract::State(state): axum::extract::State<TaskState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, TaskError> {
    Ok(data(find_task(&state.store, &id)?))
}

async fn list_tasks(
    axum::extract::State(state): axum::extract::State<TaskState>,
    RawQuery(query): RawQuery,
) -> Result<Json<Value>, TaskError> {
    let filters = TaskFilters::parse(query.as_deref().unwrap_or_default())?;
    let tasks = state.store.with_connection(move |connection| {
        let mut conditions = Vec::<String>::new();
        let mut values = Vec::<SqlValue>::new();
        add_many(&mut conditions, &mut values, "t.project_id", filters.project_ids);
        add_many(&mut conditions, &mut values, "t.status", filters.statuses);
        add_many(&mut conditions, &mut values, "t.priority", filters.priorities);
        if let Some(search) = filters.search.filter(|value| !value.is_empty()) {
            conditions.push("(t.title LIKE ? OR COALESCE(t.description,'') LIKE ? OR t.identifier LIKE ?)".to_owned());
            let search = format!("%{search}%");
            values.extend([SqlValue::Text(search.clone()), SqlValue::Text(search.clone()), SqlValue::Text(search)]);
        }
        if !filters.label_ids.is_empty() {
            conditions.push(format!(
                "t.id IN (SELECT task_id FROM task_label_assignments WHERE label_id IN ({}) GROUP BY task_id HAVING COUNT(DISTINCT label_id)=?)",
                placeholders(filters.label_ids.len())
            ));
            let label_count = i64::try_from(filters.label_ids.len()).unwrap_or(i64::MAX);
            values.extend(filters.label_ids.into_iter().map(SqlValue::Text));
            values.push(SqlValue::Integer(label_count));
        }
        let where_clause = if conditions.is_empty() { String::new() } else { format!(" WHERE {}", conditions.join(" AND ")) };
        let sort = match filters.sort.as_str() {
            "created" => "t.created_at",
            "priority" => "CASE t.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 ELSE 5 END",
            _ => "t.updated_at",
        };
        let sql = format!("{TASK_SELECT}{where_clause} GROUP BY t.id ORDER BY {sort} {}, t.identifier ASC", filters.order.to_uppercase());
        let mut statement = connection.prepare(&sql)?;
        statement
            .query_map(params_from_iter(values), task_from_row)?
            .collect::<rusqlite::Result<Vec<Task>>>()
    }).map_err(TaskError::storage)?;
    Ok(data(tasks))
}

async fn update_task(
    axum::extract::State(state): axum::extract::State<TaskState>,
    Path(id): Path<String>,
    body: Bytes,
) -> Result<Json<Value>, TaskError> {
    let input: Value = decode(&body)?;
    let current = find_task(&state.store, &id)?;
    let title = optional_string(&input, "title")?
        .map(|value| clean_required(&value, "INVALID_TASK_TITLE", "Task title is required"))
        .transpose()?
        .unwrap_or(current.title);
    let status = optional_string(&input, "status")?.unwrap_or(current.status);
    let priority = optional_string(&input, "priority")?.unwrap_or(current.priority);
    validate_status(&status)?;
    validate_priority(&priority)?;
    let description =
        optional_nullable_string(&input, "description")?.unwrap_or(current.description);
    let due_date = optional_nullable_string(&input, "dueDate")?.unwrap_or(current.due_date);
    validate_due_date(due_date.as_deref())?;
    let sort_order = optional_number(&input, "sortOrder")?.unwrap_or(current.sort_order);
    let requested_project =
        optional_string(&input, "projectId")?.unwrap_or_else(|| current.project_id.clone());
    let label_ids = optional_string_array(&input, "labelIds")?.map(deduplicate);
    let update_id = id.clone();
    let now = now_iso();
    let result = state.store.with_connection(move |connection| {
        let transaction = connection.transaction()?;
        let mut project_id = current.project_id;
        let mut task_number = current.task_number;
        let mut identifier = current.identifier;
        if requested_project != project_id {
            let project = transaction.query_row(
                "UPDATE task_projects SET next_task_number=next_task_number+1,updated_at=? WHERE id=? RETURNING key,next_task_number-1",
                params![now, requested_project],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
            ).optional()?;
            let Some((key, next_number)) = project else { return Err(rusqlite::Error::QueryReturnedNoRows); };
            project_id = requested_project;
            task_number = next_number;
            identifier = format!("{key}-{task_number}");
        }
        let completed_at = if status == "done" { current.completed_at.or_else(|| Some(now.clone())) } else { None };
        transaction.execute(
            "UPDATE tasks SET project_id=?,task_number=?,identifier=?,title=?,description=?,status=?,priority=?,due_date=?,sort_order=?,updated_at=?,completed_at=? WHERE id=?",
            params![project_id, task_number, identifier, title, description, status, priority, due_date, sort_order, now, completed_at, update_id],
        )?;
        if let Some(labels) = label_ids { replace_labels(&transaction, &update_id, &labels)?; }
        transaction.commit()
    });
    if let Err(error) = result {
        return Err(map_foreign_key(error));
    }
    Ok(data(find_task(&state.store, &id)?))
}

async fn delete_task(
    axum::extract::State(state): axum::extract::State<TaskState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, TaskError> {
    let removed = state
        .store
        .with_connection(move |connection| connection.execute("DELETE FROM tasks WHERE id=?", [id]))
        .map_err(TaskError::storage)?;
    if removed == 0 {
        return Err(TaskError::not_found("TASK_NOT_FOUND", "Task was not found"));
    }
    Ok(data(Value::Null))
}

#[derive(Default)]
struct TaskFilters {
    project_ids: Vec<String>,
    statuses: Vec<String>,
    priorities: Vec<String>,
    label_ids: Vec<String>,
    search: Option<String>,
    sort: String,
    order: String,
}

impl TaskFilters {
    fn parse(query: &str) -> Result<Self, TaskError> {
        let mut result = Self {
            sort: "updated".to_owned(),
            order: "desc".to_owned(),
            ..Self::default()
        };
        for (key, raw) in url::form_urlencoded::parse(query.as_bytes()) {
            let values = raw
                .split(',')
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned);
            match key.as_ref() {
                "projectId" => result.project_ids.extend(values),
                "status" => result.statuses.extend(values),
                "priority" => result.priorities.extend(values),
                "labelId" => result.label_ids.extend(values),
                "search" => result.search = Some(raw.into_owned()),
                "sort" => result.sort = raw.into_owned(),
                "order" => result.order = raw.into_owned(),
                _ => {}
            }
        }
        if result.statuses.iter().any(|value| !valid_status(value)) {
            return Err(TaskError::bad(
                "INVALID_REQUEST",
                "Invalid task status filter",
            ));
        }
        if result.priorities.iter().any(|value| !valid_priority(value)) {
            return Err(TaskError::bad(
                "INVALID_REQUEST",
                "Invalid task priority filter",
            ));
        }
        if !matches!(result.sort.as_str(), "created" | "updated" | "priority") {
            return Err(TaskError::bad("INVALID_REQUEST", "Invalid sort value"));
        }
        if !matches!(result.order.as_str(), "asc" | "desc") {
            return Err(TaskError::bad("INVALID_REQUEST", "Invalid order value"));
        }
        Ok(result)
    }
}

fn find_project(store: &StateStore, id: &str) -> Result<Project, TaskError> {
    let id = id.to_owned();
    store.with_connection(move |connection| {
        connection.query_row(
            "SELECT id,name,key,description,color,next_task_number,created_at,updated_at FROM task_projects WHERE id=?",
            [id], |row| project_from_row(row, 0),
        ).optional()
    }).map_err(TaskError::storage)?.ok_or_else(|| TaskError::not_found("PROJECT_NOT_FOUND", "Project was not found"))
}

fn find_label(store: &StateStore, id: &str) -> Result<Label, TaskError> {
    let id = id.to_owned();
    store
        .with_connection(move |connection| {
            connection
                .query_row(
                    "SELECT id,name,color,created_at FROM task_labels WHERE id=?",
                    [id],
                    label_from_row,
                )
                .optional()
        })
        .map_err(TaskError::storage)?
        .ok_or_else(|| TaskError::not_found("LABEL_NOT_FOUND", "Label was not found"))
}

fn find_task(store: &StateStore, id: &str) -> Result<Task, TaskError> {
    let id = id.to_owned();
    store
        .with_connection(move |connection| {
            connection
                .query_row(
                    &format!("{TASK_SELECT} WHERE t.id=? GROUP BY t.id"),
                    [id],
                    task_from_row,
                )
                .optional()
        })
        .map_err(TaskError::storage)?
        .ok_or_else(|| TaskError::not_found("TASK_NOT_FOUND", "Task was not found"))
}

fn replace_labels(
    transaction: &rusqlite::Transaction<'_>,
    task_id: &str,
    label_ids: &[String],
) -> rusqlite::Result<()> {
    transaction.execute(
        "DELETE FROM task_label_assignments WHERE task_id=?",
        [task_id],
    )?;
    for label_id in label_ids {
        transaction.execute(
            "INSERT INTO task_label_assignments(task_id,label_id) VALUES(?,?)",
            params![task_id, label_id],
        )?;
    }
    Ok(())
}

fn map_foreign_key(error: crate::store::StoreError) -> TaskError {
    let message = error.to_string();
    if message.contains("FOREIGN KEY constraint failed")
        || message.contains("Query returned no rows")
    {
        TaskError::not_found("PROJECT_NOT_FOUND", "Project was not found")
    } else {
        TaskError::storage(error)
    }
}

fn decode<T: DeserializeOwned>(body: &[u8]) -> Result<T, TaskError> {
    serde_json::from_slice(body)
        .map_err(|_| TaskError::bad("INVALID_REQUEST", "Request body must be valid JSON"))
}

fn data(value: impl Serialize) -> Json<Value> {
    Json(json!({ "data": value }))
}

fn clean_required(
    value: &str,
    code: &'static str,
    message: &'static str,
) -> Result<String, TaskError> {
    let value = value.trim();
    if value.is_empty() {
        Err(TaskError::bad(code, message))
    } else {
        Ok(value.to_owned())
    }
}

fn validate_color(value: &str) -> Result<(), TaskError> {
    if value.len() == 7
        && value.starts_with('#')
        && value[1..].bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        Ok(())
    } else {
        Err(TaskError::bad(
            "INVALID_COLOR",
            "Color must be a six-digit hex value",
        ))
    }
}

fn validate_due_date(value: Option<&str>) -> Result<(), TaskError> {
    let Some(value) = value else {
        return Ok(());
    };
    let bytes = value.as_bytes();
    let shape = bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| index == 4 || index == 7 || byte.is_ascii_digit());
    if !shape {
        return Err(TaskError::bad(
            "INVALID_DUE_DATE",
            "Due date must use YYYY-MM-DD",
        ));
    }
    let year = value[0..4].parse::<u16>().unwrap_or(0);
    let month = value[5..7].parse::<u8>().unwrap_or(0);
    let day = value[8..10].parse::<u8>().unwrap_or(0);
    if year == 0 || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return Err(TaskError::bad(
            "INVALID_DUE_DATE",
            "Due date must use YYYY-MM-DD",
        ));
    }
    Ok(())
}

fn valid_status(value: &str) -> bool {
    matches!(
        value,
        "backlog" | "todo" | "in_progress" | "done" | "canceled"
    )
}
fn valid_priority(value: &str) -> bool {
    matches!(value, "no_priority" | "urgent" | "high" | "medium" | "low")
}
fn validate_status(value: &str) -> Result<(), TaskError> {
    valid_status(value)
        .then_some(())
        .ok_or_else(|| TaskError::bad("INVALID_REQUEST", "Invalid task status"))
}
fn validate_priority(value: &str) -> Result<(), TaskError> {
    valid_priority(value)
        .then_some(())
        .ok_or_else(|| TaskError::bad("INVALID_REQUEST", "Invalid task priority"))
}

fn optional_string(value: &Value, key: &str) -> Result<Option<String>, TaskError> {
    match value.get(key) {
        None => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        _ => Err(TaskError::bad(
            "INVALID_REQUEST",
            format!("{key} must be a string"),
        )),
    }
}

fn optional_nullable_string(value: &Value, key: &str) -> Result<Option<Option<String>>, TaskError> {
    match value.get(key) {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(None)),
        Some(Value::String(value)) => Ok(Some(Some(value.clone()))),
        _ => Err(TaskError::bad(
            "INVALID_REQUEST",
            format!("{key} must be a string or null"),
        )),
    }
}

fn optional_number(value: &Value, key: &str) -> Result<Option<f64>, TaskError> {
    match value.get(key) {
        None => Ok(None),
        Some(Value::Number(value)) => value
            .as_f64()
            .map(Some)
            .ok_or_else(|| TaskError::bad("INVALID_REQUEST", format!("{key} must be a number"))),
        _ => Err(TaskError::bad(
            "INVALID_REQUEST",
            format!("{key} must be a number"),
        )),
    }
}

fn optional_string_array(value: &Value, key: &str) -> Result<Option<Vec<String>>, TaskError> {
    let Some(value) = value.get(key) else {
        return Ok(None);
    };
    let Value::Array(values) = value else {
        return Err(TaskError::bad(
            "INVALID_REQUEST",
            format!("{key} must be an array"),
        ));
    };
    values
        .iter()
        .map(|value| {
            value.as_str().map(str::to_owned).ok_or_else(|| {
                TaskError::bad("INVALID_REQUEST", format!("{key} must contain strings"))
            })
        })
        .collect::<Result<Vec<_>, _>>()
        .map(Some)
}

fn deduplicate(values: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    values
        .into_iter()
        .filter(|value| seen.insert(value.clone()))
        .collect()
}

fn add_many(
    conditions: &mut Vec<String>,
    args: &mut Vec<SqlValue>,
    column: &str,
    values: Vec<String>,
) {
    if values.is_empty() {
        return;
    }
    conditions.push(format!("{column} IN ({})", placeholders(values.len())));
    args.extend(values.into_iter().map(SqlValue::Text));
}

fn placeholders(count: usize) -> String {
    std::iter::repeat_n("?", count)
        .collect::<Vec<_>>()
        .join(",")
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |duration| {
            i64::try_from(duration.as_millis()).unwrap_or(i64::MAX)
        })
}
