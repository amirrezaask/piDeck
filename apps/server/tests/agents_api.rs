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
    workspace: std::path::PathBuf,
}
impl Harness {
    async fn start(token: Option<&str>) -> Self {
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
                workspace_path: workspace.clone(),
                file_path: None,
                source: Some(LaunchSource::Default),
            },
            static_dir: None,
            auth_token: token.map(str::to_owned),
            cors_origins: Vec::new(),
            features: HostFeatures {
                terminal_checkpoints: true,
            },
        };
        Self {
            server: serve(config).await.expect("server"),
            _temp: temp,
            workspace,
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
async fn agent_profiles_projects_and_inbox_are_persisted_under_the_agents_namespace() {
    let harness = Harness::start(None).await;
    let client = reqwest::Client::new();
    let project = client
        .post(harness.url("/agents/v1/projects"))
        .json(&json!({"path":harness.workspace}))
        .send()
        .await
        .expect("project");
    assert_eq!(project.status(), StatusCode::CREATED);
    assert_eq!(
        body(project).await["path"],
        harness.workspace.to_string_lossy().as_ref()
    );

    let created = client.post(harness.url("/agents/v1/agents")).json(&json!({
        "name":"Review agent", "systemPrompt":"Review changes carefully.", "cwd":harness.workspace,
        "tools":["read","bash"], "thinkingLevel":"high"
    })).send().await.expect("agent");
    assert_eq!(created.status(), StatusCode::CREATED);
    let agent = body(created).await;
    assert_eq!(agent["name"], "Review agent");
    assert!(agent.get("status").is_none());

    let listed = body(
        client
            .get(harness.url("/agents/v1/agents"))
            .send()
            .await
            .expect("agents"),
    )
    .await;
    assert_eq!(listed["agents"].as_array().expect("agents").len(), 1);

    let inbox = client
        .post(harness.url("/agents/v1/inbox"))
        .json(&json!({"kind":"question","title":"Choose?","body":"Pick one","options":["A","B"]}))
        .send()
        .await
        .expect("inbox");
    assert_eq!(inbox.status(), StatusCode::CREATED);
    let item = body(inbox).await;
    let id = item["id"].as_str().expect("id");
    let resolved = body(
        client
            .post(harness.url(&format!("/agents/v1/inbox/{id}/resolve")))
            .json(&json!({"response":"A"}))
            .send()
            .await
            .expect("resolve"),
    )
    .await;
    assert_eq!(resolved["status"], "resolved");
    assert_eq!(resolved["response"], "A");
}

#[cfg(unix)]
#[tokio::test]
async fn pi_rpc_events_complete_and_persist_an_agent_run() {
    use std::{fs, os::unix::fs::PermissionsExt as _};

    let executable_dir = tempfile::tempdir().expect("executable dir");
    let executable = executable_dir.path().join("fake-pi");
    fs::write(
        &executable,
        "#!/bin/sh\nread request\nprintf '%s\\n' '{\"type\":\"agent_start\"}' '{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"done\"}]}}' '{\"type\":\"agent_end\",\"messages\":[],\"willRetry\":false}'\nwhile read request; do :; done\n",
    )
    .expect("fake executable");
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).expect("permissions");
    let previous = std::env::var_os("PI_EXECUTABLE");
    // SAFETY: this integration-test process controls all agent launches and restores the value
    // immediately after the run handler has spawned its child process.
    unsafe { std::env::set_var("PI_EXECUTABLE", &executable) };

    let harness = Harness::start(None).await;
    let client = reqwest::Client::new();
    let agent = body(
        client
            .post(harness.url("/agents/v1/agents"))
            .json(&json!({"name":"RPC agent","systemPrompt":"Test.","cwd":harness.workspace}))
            .send()
            .await
            .expect("agent"),
    )
    .await;
    let agent_id = agent["id"].as_str().expect("agent id");
    let run = body(
        client
            .post(harness.url("/agents/v1/runs"))
            .json(&json!({"agentId":agent_id,"prompt":"Run the test."}))
            .send()
            .await
            .expect("run"),
    )
    .await;
    match previous {
        Some(value) => unsafe { std::env::set_var("PI_EXECUTABLE", value) },
        None => unsafe { std::env::remove_var("PI_EXECUTABLE") },
    }
    let run_id = run["id"].as_str().expect("run id");

    let completed = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let run = body(
                client
                    .get(harness.url(&format!("/agents/v1/runs/{run_id}")))
                    .send()
                    .await
                    .expect("get run"),
            )
            .await;
            if run["status"] == "completed" {
                break run;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("run completion");
    assert!(completed["completedAt"].is_string());

    let events = body(
        client
            .get(harness.url(&format!("/agents/v1/runs/{run_id}/events?afterSequence=0")))
            .send()
            .await
            .expect("events"),
    )
    .await;
    let kinds = events["events"]
        .as_array()
        .expect("event list")
        .iter()
        .filter_map(|event| event["type"].as_str())
        .collect::<Vec<_>>();
    assert!(kinds.contains(&"agent_end"));
    assert!(kinds.contains(&"agent_settled"));
    harness.server.shutdown().await;
}

#[tokio::test]
async fn shared_host_token_protects_tasks_and_agents_while_health_stays_public() {
    let harness = Harness::start(Some("secret")).await;
    let client = reqwest::Client::new();
    assert_eq!(
        client
            .get(harness.url("/agents/v1/health"))
            .send()
            .await
            .expect("health")
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        client
            .get(harness.url("/agents/v1/agents"))
            .send()
            .await
            .expect("agents")
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        client
            .get(harness.url("/tasks/api/projects"))
            .send()
            .await
            .expect("tasks")
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        client
            .get(harness.url("/agents/v1/agents"))
            .bearer_auth("secret")
            .send()
            .await
            .expect("authorized")
            .status(),
        StatusCode::OK
    );
}
