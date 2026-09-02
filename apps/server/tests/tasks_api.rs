use reqwest::StatusCode;
use serde_json::{Value, json};
use tempfile::TempDir;
use yaade_server::{
    config::{HostConfig, HostFeatures, LaunchConfig, LaunchSource},
    server::{RunningServer, serve},
};

struct Harness {
    server: RunningServer,
    _temp: TempDir,
}
impl Harness {
    async fn start() -> Self {
        let temp = tempfile::tempdir().expect("temp dir");
        let workspace = std::env::current_dir().expect("cwd");
        let config = HostConfig {
            host: "127.0.0.1".to_owned(),
            port: 0,
            data_dir: temp.path().to_owned(),
            allowed_roots: vec![workspace.clone()],
            open_browser: false,
            launch_path: workspace.clone(),
            launch_config: LaunchConfig {
                workspace_path: workspace,
                file_path: None,
                source: Some(LaunchSource::Default),
            },
            static_dir: None,
            auth_token: None,
            cors_origins: Vec::new(),
            features: HostFeatures {
                terminal_checkpoints: true,
            },
        };
        Self {
            server: serve(config).await.expect("server"),
            _temp: temp,
        }
    }
    fn url(&self, path: &str) -> String {
        format!("http://{}{}", self.server.address, path)
    }
}

async fn body(response: reqwest::Response) -> Value {
    response.json().await.expect("json")
}

#[tokio::test]
async fn task_crud_filters_labels_and_project_guards_share_the_host_database() {
    let harness = Harness::start().await;
    let client = reqwest::Client::new();
    let projects = body(
        client
            .get(harness.url("/tasks/api/projects"))
            .send()
            .await
            .expect("projects"),
    )
    .await;
    let project_id = projects["data"][0]["id"].as_str().expect("default project");

    let first = client.post(harness.url("/tasks/api/tasks")).json(&json!({
        "projectId": project_id, "title": "Fix keyboard navigation", "description": "Accessibility",
        "priority": "urgent", "status": "todo"
    })).send().await.expect("create");
    assert_eq!(first.status(), StatusCode::OK);
    let first = body(first).await;
    assert_eq!(first["data"]["identifier"], "DSP-1");

    let second = body(
        client
            .post(harness.url("/tasks/api/tasks"))
            .json(&json!({
                "projectId": project_id, "title": "Polish sidebar", "priority": "low"
            }))
            .send()
            .await
            .expect("create"),
    )
    .await;
    assert_eq!(second["data"]["identifier"], "DSP-2");

    let filtered = body(
        client
            .get(harness.url("/tasks/api/tasks?status=todo&priority=urgent"))
            .send()
            .await
            .expect("filter"),
    )
    .await;
    assert_eq!(filtered["data"].as_array().expect("tasks").len(), 1);
    let searched = body(
        client
            .get(harness.url("/tasks/api/tasks?search=accessibility"))
            .send()
            .await
            .expect("search"),
    )
    .await;
    assert_eq!(searched["data"][0]["title"], "Fix keyboard navigation");

    let label = body(
        client
            .post(harness.url("/tasks/api/labels"))
            .json(&json!({"name":"Bug","color":"#ef4444"}))
            .send()
            .await
            .expect("label"),
    )
    .await;
    let label_id = label["data"]["id"].as_str().expect("label id");
    let task_id = first["data"]["id"].as_str().expect("task id");
    let updated = body(
        client
            .patch(harness.url(&format!("/tasks/api/tasks/{task_id}")))
            .json(&json!({"status":"done","labelIds":[label_id]}))
            .send()
            .await
            .expect("update"),
    )
    .await;
    assert_eq!(updated["data"]["status"], "done");
    assert!(updated["data"]["completedAt"].is_string());
    assert_eq!(updated["data"]["labels"][0]["name"], "Bug");

    let guarded = client
        .delete(harness.url(&format!("/tasks/api/projects/{project_id}")))
        .send()
        .await
        .expect("guard");
    assert_eq!(guarded.status(), StatusCode::CONFLICT);
    let deleted = client
        .delete(harness.url(&format!("/tasks/api/projects/{project_id}?cascade=true")))
        .send()
        .await
        .expect("cascade");
    assert_eq!(deleted.status(), StatusCode::OK);
}

#[tokio::test]
async fn task_validation_and_uniqueness_errors_keep_dispatch_contracts() {
    let harness = Harness::start().await;
    let client = reqwest::Client::new();
    let projects = body(
        client
            .get(harness.url("/tasks/api/projects"))
            .send()
            .await
            .expect("projects"),
    )
    .await;
    let project_id = projects["data"][0]["id"].as_str().expect("project");
    let invalid = client
        .post(harness.url("/tasks/api/tasks"))
        .json(&json!({"projectId":project_id,"title":"   "}))
        .send()
        .await
        .expect("invalid");
    assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);
    assert_eq!(body(invalid).await["error"]["code"], "INVALID_TASK_TITLE");

    let first = client
        .post(harness.url("/tasks/api/projects"))
        .json(&json!({"name":"Personal","key":"PER"}))
        .send()
        .await
        .expect("project");
    assert_eq!(first.status(), StatusCode::OK);
    let duplicate = client
        .post(harness.url("/tasks/api/projects"))
        .json(&json!({"name":"Duplicate","key":"per"}))
        .send()
        .await
        .expect("duplicate");
    assert_eq!(duplicate.status(), StatusCode::CONFLICT);
    assert_eq!(body(duplicate).await["error"]["code"], "PROJECT_KEY_EXISTS");
}
