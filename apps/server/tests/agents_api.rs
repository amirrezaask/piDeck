use futures_util::StreamExt as _;
use reqwest::StatusCode;
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio_tungstenite::{
    connect_async,
    tungstenite::{Message, client::IntoClientRequest as _, http::HeaderValue},
};
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
    fn ws_url(&self, path: &str) -> String {
        format!("ws://{}{}", self.server.address, path)
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

    let second = client
        .post(harness.url("/agents/v1/agents"))
        .json(&json!({"name":"Second agent","systemPrompt":"Test pagination.","cwd":harness.workspace}))
        .send()
        .await
        .expect("second agent");
    assert_eq!(second.status(), StatusCode::CREATED);
    let first_page = body(
        client
            .get(harness.url("/agents/v1/agents?limit=1"))
            .send()
            .await
            .expect("first agent page"),
    )
    .await;
    let cursor = first_page["nextCursor"].as_str().expect("next cursor");
    let second_page = body(
        client
            .get(harness.url(&format!("/agents/v1/agents?limit=1&cursor={cursor}")))
            .send()
            .await
            .expect("second agent page"),
    )
    .await;
    assert_eq!(first_page["agents"].as_array().map(Vec::len), Some(1));
    assert_eq!(second_page["agents"].as_array().map(Vec::len), Some(1));
    assert_ne!(
        first_page["agents"][0]["id"],
        second_page["agents"][0]["id"]
    );

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
async fn client_contract_covers_models_run_options_events_streaming_and_idempotency() {
    use std::{fs, os::unix::fs::PermissionsExt as _};

    let executable_dir = tempfile::tempdir().expect("executable dir");
    let executable = executable_dir.path().join("fake-pi");
    let command_log = executable_dir.path().join("commands.jsonl");
    let argument_log = executable_dir.path().join("arguments.txt");
    let script = format!(
        r#"#!/bin/sh
if [ "$1" = "--list-models" ]; then
  printf '%s\n' 'provider model context max-out thinking images' 'fake fake-default 128K 32K yes yes' 'override override-model 128K 32K yes yes'
  exit 0
fi
printf '%s\n' "$*" > '{}'
read request
printf '%s\n' "$request" >> '{}'
printf '%s\n' '{{"id":"prompt-response","type":"response","command":"prompt","success":true}}' '{{"type":"agent_start"}}'
i=1
while [ "$i" -le 520 ]; do
  printf '{{"type":"message_update","assistantMessageEvent":{{"type":"text_delta","delta":"chunk-%s "}}}}\n' "$i"
  i=$((i + 1))
done
printf '%s\n' '{{"type":"message_end","message":{{"role":"assistant","content":[{{"type":"text","text":"done"}}]}}}}' '{{"type":"agent_end","messages":[],"willRetry":false}}' '{{"type":"agent_settled"}}'
while read request; do
  printf '%s\n' "$request" >> '{}'
done
"#,
        argument_log.display(),
        command_log.display(),
        command_log.display(),
    );
    fs::write(&executable, script).expect("fake executable");
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).expect("permissions");
    let previous = std::env::var_os("PI_EXECUTABLE");
    // SAFETY: this integration test is the only test that starts Pi and restores the process
    // environment before returning.
    unsafe { std::env::set_var("PI_EXECUTABLE", &executable) };

    let harness = Harness::start(None).await;
    let client = reqwest::Client::new();

    let models = body(
        client
            .get(harness.url("/agents/v1/models"))
            .send()
            .await
            .expect("models"),
    )
    .await;
    assert_eq!(models["models"].as_array().map(Vec::len), Some(2));
    assert_eq!(models["defaultModel"]["id"], "fake-default");

    let agent = body(
        client
            .post(harness.url("/agents/v1/agents"))
            .json(&json!({
                "name":"RPC agent",
                "systemPrompt":"Test.",
                "cwd":harness.workspace,
                "model":{"provider":"fake","id":"fake-default"},
                "thinkingLevel":"low"
            }))
            .send()
            .await
            .expect("agent"),
    )
    .await;
    let agent_id = agent["id"].as_str().expect("agent id");
    let run_request = json!({
        "agentId":agent_id,
        "prompt":"Run the test.",
        "model":{"provider":"override","id":"override-model"},
        "thinkingLevel":"xhigh",
        "cwd":harness.workspace,
        "idempotencyKey":"run-once",
        "attachments":[{"name":"screen.png","mimeType":"image/png","data":"aW1hZ2U="}]
    });
    let response = client
        .post(harness.url("/agents/v1/runs"))
        .json(&run_request)
        .send()
        .await
        .expect("run");
    assert_eq!(response.status(), StatusCode::ACCEPTED);
    let run = body(response).await;
    let run_id = run["id"].as_str().expect("run id");
    assert!(run["acknowledgementId"].is_string());
    assert_eq!(run["model"]["id"], "override-model");
    assert_eq!(run["thinkingLevel"], "xhigh");

    let replay = body(
        client
            .post(harness.url("/agents/v1/runs"))
            .json(&run_request)
            .send()
            .await
            .expect("idempotent replay"),
    )
    .await;
    assert_eq!(replay["id"], run_id);
    assert_eq!(replay["acknowledgementId"], run["acknowledgementId"]);

    let conflict = client
        .post(harness.url("/agents/v1/runs"))
        .json(&json!({
            "agentId":agent_id,
            "prompt":"Different work.",
            "idempotencyKey":"run-once"
        }))
        .send()
        .await
        .expect("idempotency conflict");
    assert_eq!(conflict.status(), StatusCode::CONFLICT);
    assert_eq!(
        body(conflict).await["error"]["code"],
        "idempotency_conflict"
    );

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

    let latest = body(
        client
            .get(harness.url(&format!(
                "/agents/v1/runs/{run_id}/events?afterSequence=0&beforeSequence=9007199254740991&limit=10"
            )))
            .send()
            .await
            .expect("latest events"),
    )
    .await;
    let latest_events = latest["events"].as_array().expect("latest event page");
    assert_eq!(latest_events.len(), 10);
    assert!(latest["hasMore"].as_bool().is_some_and(|value| value));
    assert!(latest["previousSequence"].is_number());
    assert!(
        latest_events
            .windows(2)
            .all(|pair| { pair[0]["sequence"].as_i64() < pair[1]["sequence"].as_i64() })
    );
    assert!(
        latest_events
            .iter()
            .any(|event| event["type"] == "agent_settled")
    );

    let oldest = latest_events[0]["sequence"]
        .as_i64()
        .expect("oldest sequence");
    let previous_page = body(
        client
            .get(harness.url(&format!(
                "/agents/v1/runs/{run_id}/events?afterSequence=0&beforeSequence={oldest}&limit=10"
            )))
            .send()
            .await
            .expect("previous events"),
    )
    .await;
    assert!(previous_page["events"].as_array().is_some_and(|events| {
        events
            .iter()
            .all(|event| event["sequence"].as_i64() < Some(oldest))
    }));

    let receipt = body(
        client
            .get(harness.url("/agents/v1/command-receipts/run-once"))
            .send()
            .await
            .expect("receipt"),
    )
    .await;
    assert_eq!(receipt["command"], "run_create");
    assert_eq!(receipt["status"], "succeeded");
    assert_eq!(receipt["result"]["id"], run_id);

    let steer_request = json!({
        "message":"Focus once.",
        "idempotencyKey":"steer-once",
        "attachments":[{"name":"detail.png","mimeType":"image/png","data":"aW1hZ2U="}]
    });
    for _ in 0..2 {
        let response = client
            .post(harness.url(&format!("/agents/v1/runs/{run_id}/steer")))
            .json(&steer_request)
            .send()
            .await
            .expect("steer");
        assert_eq!(response.status(), StatusCode::ACCEPTED);
    }

    let fleet = body(
        client
            .get(harness.url("/agents/v1/fleet"))
            .send()
            .await
            .expect("fleet"),
    )
    .await;
    assert_eq!(fleet["runs"][0]["agentName"], "RPC agent");
    assert!(fleet["runs"][0]["children"].is_array());
    assert_eq!(fleet["counts"]["total"], 1);

    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    let arguments = fs::read_to_string(&argument_log).expect("argument log");
    assert!(arguments.contains("--provider override --model override-model"));
    assert!(arguments.contains("--thinking xhigh"));
    let commands = fs::read_to_string(&command_log).expect("command log");
    let records = commands
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).expect("command json"))
        .collect::<Vec<_>>();
    assert_eq!(
        records
            .iter()
            .filter(|record| record["type"] == "prompt")
            .count(),
        1
    );
    assert_eq!(
        records
            .iter()
            .filter(|record| record["type"] == "steer")
            .count(),
        1
    );
    assert_eq!(records[0]["images"][0]["mimeType"], "image/png");
    assert!(
        records
            .iter()
            .any(|record| record["type"] == "steer" && record["images"][0]["data"] == "aW1hZ2U=")
    );

    match previous {
        Some(value) => unsafe { std::env::set_var("PI_EXECUTABLE", value) },
        None => unsafe { std::env::remove_var("PI_EXECUTABLE") },
    }
    harness.server.shutdown().await;
}

#[tokio::test]
async fn agent_api_rejects_invalid_contract_input_and_accepts_full_size_attachments() {
    let harness = Harness::start(None).await;
    let client = reqwest::Client::new();
    for payload in [
        json!({"systemPrompt":""}),
        json!({"systemPrompt":"Valid", "systemPromptMode":"merge"}),
        json!({"systemPrompt":"Valid", "tools":["read","read"]}),
        json!({"systemPrompt":"Valid", "tools":["network"]}),
        json!({"systemPrompt":"Valid", "unexpected":true}),
    ] {
        let response = client
            .post(harness.url("/agents/v1/agents"))
            .json(&payload)
            .send()
            .await
            .expect("invalid agent request");
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(body(response).await["error"]["code"], "validation_failed");
    }

    let agent = body(
        client
            .post(harness.url("/agents/v1/agents"))
            .json(&json!({"systemPrompt":"Valid", "cwd":harness.workspace}))
            .send()
            .await
            .expect("agent"),
    )
    .await;
    let agent_id = agent["id"].as_str().expect("agent id");
    for payload in [
        json!({}),
        json!({"name":12}),
        json!({"systemPromptMode":"merge"}),
        json!({"tools":["read","read"]}),
        json!({"unexpected":true}),
    ] {
        let response = client
            .patch(harness.url(&format!("/agents/v1/agents/{agent_id}")))
            .json(&payload)
            .send()
            .await
            .expect("invalid agent update");
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(body(response).await["error"]["code"], "validation_failed");
    }
    for query in ["limit=0", "limit=101", "cursor=invalid", "status=unknown"] {
        let response = client
            .get(harness.url(&format!("/agents/v1/runs?{query}")))
            .send()
            .await
            .expect("invalid run page");
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(body(response).await["error"]["code"], "validation_failed");
    }
    for payload in [
        json!({"agentId":agent_id,"prompt":""}),
        json!({"agentId":agent_id,"prompt":"x","thinkingLevel":"extreme"}),
        json!({"agentId":agent_id,"prompt":"x","executionMode":"local","worktreeId":"018bcfe4-7a4b-7000-8000-000000000999"}),
        json!({"agentId":agent_id,"prompt":"x","attachments":[{"name":"bad.txt","mimeType":"text/plain","data":"eA=="}]}),
        json!({"agentId":agent_id,"prompt":"x","attachments":[{"name":"bad.png","mimeType":"image/png","data":"not base64"}]}),
    ] {
        let response = client
            .post(harness.url("/agents/v1/runs"))
            .json(&payload)
            .send()
            .await
            .expect("invalid run request");
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(body(response).await["error"]["code"], "validation_failed");
    }

    let invalid_page = client
        .get(harness.url(&format!("/agents/v1/agents/{agent_id}/events?limit=501")))
        .send()
        .await
        .expect("invalid event page");
    assert_eq!(invalid_page.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        body(invalid_page).await["error"]["code"],
        "validation_failed"
    );

    // The client contract permits four base64 images up to 8 MB each. This
    // request is intentionally larger than the host's old global 2 MB limit.
    let large_data = "A".repeat(2_400_000);
    let response = client
        .post(harness.url("/agents/v1/runs"))
        .json(&json!({
            "agentId":"018bcfe4-7a4b-7000-8000-000000000999",
            "prompt":"Validate the upload boundary.",
            "attachments":[{"name":"large.png","mimeType":"image/png","data":large_data}]
        }))
        .send()
        .await
        .expect("large attachment request");
    assert_ne!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    assert_eq!(body(response).await["error"]["code"], "not_found");
    harness.server.shutdown().await;
}

#[tokio::test]
async fn event_stream_authenticates_replays_and_consumes_tickets_once() {
    let harness = Harness::start(Some("stream-secret")).await;
    let client = reqwest::Client::new();
    let agent = body(
        client
            .post(harness.url("/agents/v1/agents"))
            .bearer_auth("stream-secret")
            .json(&json!({"systemPrompt":"Stream safely."}))
            .send()
            .await
            .expect("agent"),
    )
    .await;
    let agent_id = agent["id"].as_str().expect("agent id");
    let ticket = body(
        client
            .post(harness.url("/agents/v1/ws-tickets"))
            .bearer_auth("stream-secret")
            .send()
            .await
            .expect("ticket"),
    )
    .await;
    let ticket = ticket["ticket"].as_str().expect("ticket");
    let stream_url = harness.ws_url(&format!(
        "/agents/v1/agents/{agent_id}/stream?afterSequence=0&ticket={ticket}"
    ));
    let (mut socket, _) = connect_async(&stream_url).await.expect("ticket socket");
    let event = tokio::time::timeout(std::time::Duration::from_secs(2), socket.next())
        .await
        .expect("event timeout")
        .expect("open socket")
        .expect("event frame");
    let Message::Text(event) = event else {
        panic!("expected text event")
    };
    let event: Value = serde_json::from_str(event.as_str()).expect("event json");
    assert_eq!(event["agentId"], agent_id);
    assert_eq!(event["type"], "supervisor.agent_created");
    assert!(
        event["sequence"]
            .as_u64()
            .is_some_and(|sequence| sequence > 0)
    );
    socket.close(None).await.expect("close stream");

    let replay = connect_async(&stream_url).await;
    assert!(matches!(
        replay,
        Err(tokio_tungstenite::tungstenite::Error::Http(response))
            if response.status() == StatusCode::UNAUTHORIZED
    ));
    let mut unknown_request = harness
        .ws_url("/agents/v1/agents/018bcfe4-7a4b-7000-8000-000000000999/stream?afterSequence=0")
        .into_client_request()
        .expect("websocket request");
    unknown_request.headers_mut().insert(
        "authorization",
        HeaderValue::from_static("Bearer stream-secret"),
    );
    let unknown = connect_async(unknown_request).await;
    assert!(matches!(
        unknown,
        Err(tokio_tungstenite::tungstenite::Error::Http(response))
            if response.status().as_u16() == StatusCode::NOT_FOUND.as_u16()
    ));
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
