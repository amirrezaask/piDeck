use std::time::Duration;

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use futures_util::{SinkExt as _, StreamExt as _};
use reqwest::StatusCode;
use ring::{
    rand::SystemRandom,
    signature::{Ed25519KeyPair, KeyPair as _},
};
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use yaade_server::{
    config::{HostConfig, HostFeatures, LaunchConfig, LaunchSource},
    device_auth::{AuthenticateDevice, DeviceScope, PairDevice},
    runtime::Principal,
    server::{RunningServer, serve},
};

struct Harness {
    server: RunningServer,
    _temp: TempDir,
}

impl Harness {
    async fn start(token: Option<&str>) -> Self {
        let temp = tempfile::tempdir().expect("temp dir");
        let server = serve(config(&temp, 0, token)).await.expect("server");
        Self {
            server,
            _temp: temp,
        }
    }

    fn http(&self, path: &str) -> String {
        format!("http://{}{}", self.server.address, path)
    }

    fn ws(&self, query: &str) -> String {
        format!("ws://{}/terminal/ws{query}", self.server.address)
    }
}

fn config(temp: &TempDir, port: u16, token: Option<&str>) -> HostConfig {
    let workspace = std::env::current_dir().expect("cwd");
    HostConfig {
        host: "127.0.0.1".to_owned(),
        port,
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
        auth_token: token.map(str::to_owned),
        cors_origins: Vec::new(),
        features: HostFeatures {
            terminal_checkpoints: true,
        },
    }
}

async fn json_message<S>(socket: &mut tokio_tungstenite::WebSocketStream<S>) -> Value
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    loop {
        let message = tokio::time::timeout(Duration::from_secs(5), socket.next())
            .await
            .expect("message timeout")
            .expect("socket open")
            .expect("valid message");
        if let Message::Text(text) = message {
            return serde_json::from_str(text.as_str()).expect("json message");
        }
    }
}

async fn modern_socket(
    harness: &Harness,
    token: Option<&str>,
) -> tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>> {
    let (mut socket, _) = connect_async(harness.ws("?protocol=2&clientId=test"))
        .await
        .expect("connect");
    if let Some(token) = token {
        assert_eq!(
            json_message(&mut socket).await["type"],
            "protocol:auth-required"
        );
        socket
            .send(Message::Text(
                json!({ "type": "protocol:auth", "token": token })
                    .to_string()
                    .into(),
            ))
            .await
            .expect("authenticate");
    }
    socket
}

#[tokio::test]
async fn host_token_gate_keeps_health_public_and_requires_token_for_api_and_websocket() {
    let harness = Harness::start(Some("secret-token")).await;
    let client = reqwest::Client::new();
    assert_eq!(
        client
            .get(harness.http("/terminal/health"))
            .send()
            .await
            .expect("health")
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        client
            .get(harness.http("/terminal/api/v1/system"))
            .send()
            .await
            .expect("system")
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        client
            .get(harness.http("/terminal/api/v1/system"))
            .bearer_auth("secret-token")
            .send()
            .await
            .expect("system")
            .status(),
        StatusCode::OK
    );

    let denied = connect_async(harness.ws("?protocol=1&token=wrong")).await;
    assert!(
        matches!(denied, Err(tokio_tungstenite::tungstenite::Error::Http(response)) if response.status() == 401)
    );
    let allowed = connect_async(harness.ws("?protocol=1&token=secret-token")).await;
    assert!(allowed.is_ok());
    harness.server.shutdown().await;
}

#[tokio::test]
async fn unauthenticated_websocket_admission_is_globally_bounded() {
    let harness = Harness::start(Some("admission-secret")).await;
    let mut pending = Vec::new();
    for index in 0..64 {
        let (mut socket, _) =
            connect_async(harness.ws(&format!("?protocol=2&clientId=pending-{index}")))
                .await
                .expect("connect pending");
        assert_eq!(
            json_message(&mut socket).await["type"],
            "protocol:auth-required"
        );
        pending.push(socket);
    }
    let (mut overflow, _) = connect_async(harness.ws("?protocol=2&clientId=overflow"))
        .await
        .expect("overflow upgrade");
    let close = tokio::time::timeout(Duration::from_secs(2), overflow.next())
        .await
        .expect("overflow close timeout");
    assert!(
        matches!(close, Some(Ok(Message::Close(Some(frame)))) if frame.code == tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode::Again)
    );
    drop(pending);
    harness.server.shutdown().await;
}

#[tokio::test]
async fn modern_realtime_connections_receive_identity_snapshot_and_post_snapshot_events() {
    let harness = Harness::start(None).await;
    let mut socket = modern_socket(&harness, None).await;
    let hello = json_message(&mut socket).await;
    assert_eq!(hello["type"], "protocol:hello");
    let snapshot = json_message(&mut socket).await;
    assert_eq!(snapshot["type"], "runtime:snapshot");
    assert!(
        snapshot["sessions"]
            .as_array()
            .is_some_and(|sessions| !sessions.is_empty())
    );

    let response = reqwest::Client::new()
        .post(harness.http("/terminal/api/v1/rpc"))
        .json(&json!({ "channel": "mux:createSession", "args": ["Realtime"] }))
        .send()
        .await
        .expect("rpc");
    assert_eq!(response.status(), StatusCode::OK);
    let event = loop {
        let value = json_message(&mut socket).await;
        if value["channel"] == "mux:event" {
            break value;
        }
    };
    assert_eq!(event["protocolVersion"], 2);
    assert_eq!(event["serverId"], hello["identity"]["serverId"]);
    harness.server.shutdown().await;
}

#[tokio::test]
async fn modern_websocket_authentication_does_not_put_token_in_url() {
    let harness = Harness::start(Some("modern-secret")).await;
    let mut socket = modern_socket(&harness, Some("modern-secret")).await;
    assert_eq!(json_message(&mut socket).await["type"], "protocol:hello");
    assert_eq!(json_message(&mut socket).await["type"], "runtime:snapshot");
    harness.server.shutdown().await;
}

#[tokio::test]
async fn server_identity_survives_api_restart_while_epoch_changes() {
    let temp = tempfile::tempdir().expect("temp dir");
    let first = serve(config(&temp, 0, None)).await.expect("first server");
    let first_id = first.runtime.identity.server_id.clone();
    let first_epoch = first.runtime.identity.server_epoch.clone();
    first.shutdown().await;

    let second = serve(config(&temp, 0, None)).await.expect("second server");
    assert_eq!(second.runtime.identity.server_id, first_id);
    assert_ne!(second.runtime.identity.server_epoch, first_epoch);
    second.shutdown().await;
}

#[tokio::test]
async fn restart_preserves_workspace_and_exposes_interrupted_history_read_only() {
    let temp = tempfile::tempdir().expect("temp dir");
    let first = serve(config(&temp, 0, None)).await.expect("first server");
    let principal = Principal::local("restart-test".to_owned());
    let snapshot = first.runtime.store.list_snapshots(false).remove(0);
    let session_id = snapshot.session.id.clone();
    let tab_id = snapshot.tabs[0].id.clone();
    first
        .runtime
        .dispatch(
            &principal,
            "mux:saveTabLayout",
            &[json!({
                "tabId": tab_id,
                "layoutJson": "{\"version\":1,\"root\":{\"kind\":\"leaf\"}}",
                "revision": snapshot.tabs[0].revision,
            })],
        )
        .expect("save layout");
    let created = first
        .runtime
        .dispatch(
            &principal,
            "mux:createTerminal",
            &[json!({
                "sessionId": session_id,
                "tabId": tab_id,
                "title": "Restart history",
                "kind": "terminal",
                "input": {
                    "_tag": "TerminalInput",
                    "kind": "terminal",
                    "shellArgs": ["-c", "printf 'retained-before-restart\\n'; /bin/sleep 30"],
                },
            })],
        )
        .expect("create terminal");
    let terminal_id = created["id"].as_str().expect("mux terminal id").to_owned();
    let pty_id = created["output"]["ptyId"]
        .as_str()
        .expect("pty id")
        .to_owned();
    let generation = created["output"]["generation"]
        .as_u64()
        .expect("generation");
    tokio::time::timeout(Duration::from_secs(5), async {
        while !first.runtime.terminal.history_available(&pty_id) {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("history written");

    first.shutdown().await;
    tokio::time::sleep(Duration::from_millis(100)).await;

    let second = serve(config(&temp, 0, None)).await.expect("second server");
    let recovered = second
        .runtime
        .store
        .get_terminal(&terminal_id)
        .expect("recovered terminal");
    assert_eq!(recovered.session_id, session_id);
    assert_eq!(recovered.tab_id.as_deref(), Some(tab_id.as_str()));
    assert_eq!(
        recovered.status,
        yaade_server::model::TerminalStatus::Disconnected
    );
    assert_eq!(
        recovered.output.process_state,
        yaade_server::model::ProcessState::Interrupted
    );
    assert_eq!(recovered.output.pty_id, None);
    assert_eq!(
        recovered.output.history_id.as_deref(),
        Some(pty_id.as_str())
    );
    assert!(recovered.output.replay_available);
    assert_eq!(recovered.output.generation, generation);
    assert_eq!(
        second
            .runtime
            .store
            .get_tab(&tab_id)
            .expect("preserved tab")
            .layout_json
            .as_deref(),
        Some("{\"version\":1,\"root\":{\"kind\":\"leaf\"}}")
    );

    let attached = second
        .runtime
        .dispatch(&principal, "terminal:attach", &[json!(pty_id), json!(0)])
        .expect("read-only attach");
    assert_eq!(attached["status"], "exited");
    assert_eq!(attached["archiveAvailable"], true);
    let page = second
        .runtime
        .dispatch(
            &principal,
            "terminal:readReplayPage",
            &[json!(pty_id), json!(0), json!(256 * 1024)],
        )
        .expect("history page");
    let bytes = page["chunks"]
        .as_array()
        .expect("chunks")
        .iter()
        .flat_map(|chunk| {
            base64::engine::general_purpose::STANDARD
                .decode(chunk.as_str().expect("base64 chunk"))
                .expect("decode")
        })
        .collect::<Vec<_>>();
    assert!(String::from_utf8_lossy(&bytes).contains("retained-before-restart"));

    let restarted = second
        .runtime
        .dispatch(
            &principal,
            "mux:restartTerminal",
            &[json!(terminal_id), json!(recovered.revision)],
        )
        .expect("restart terminal");
    assert_eq!(restarted["status"], "running");
    assert_eq!(restarted["output"]["generation"], generation + 1);
    assert_ne!(restarted["output"]["ptyId"], pty_id);
    second.shutdown().await;
}

#[tokio::test]
async fn start_host_server_binds_an_os_assigned_high_port_when_preferred_is_zero() {
    let harness = Harness::start(None).await;
    assert_ne!(harness.server.address.port(), 0);
    harness.server.shutdown().await;
}

#[tokio::test]
async fn start_host_server_binds_next_port_when_preferred_is_taken() {
    let (_occupied, preferred) = (30_000_u16..40_000)
        .find_map(|port| {
            std::net::TcpListener::bind(("127.0.0.1", port))
                .ok()
                .map(|listener| (listener, port))
        })
        .expect("reserve port");
    let temp = tempfile::tempdir().expect("temp dir");
    let server = serve(config(&temp, preferred, None)).await.expect("server");
    assert_eq!(server.address.port(), preferred + 1);
    server.shutdown().await;
}

#[tokio::test]
async fn stale_websocket_reconnect_receives_replay_gap_before_retained_history() {
    let harness = Harness::start(None).await;
    for sequence in 0..1_100 {
        harness
            .server
            .runtime
            .events
            .emit("replay:test", vec![json!(sequence)]);
    }
    let (mut socket, _) = connect_async(harness.ws("?protocol=1&since=1"))
        .await
        .expect("connect");
    let gap = json_message(&mut socket).await;
    assert_eq!(gap["channel"], "protocol:replay-gap");
    assert!(gap["args"][0].as_u64().is_some_and(|floor| floor > 1));
    harness.server.shutdown().await;
}

#[tokio::test]
async fn paired_observe_scope_cannot_mutate_rpc_or_administer_devices() {
    let harness = Harness::start(None).await;
    let random = SystemRandom::new();
    let document = Ed25519KeyPair::generate_pkcs8(&random).expect("generate key");
    let key = Ed25519KeyPair::from_pkcs8(document.as_ref()).expect("key");
    let code = harness
        .server
        .runtime
        .devices
        .create_pairing_code()
        .expect("code");
    let device = harness
        .server
        .runtime
        .devices
        .pair(PairDevice {
            code: code.code,
            device_id: Some("observe_device".to_owned()),
            name: "Observer".to_owned(),
            public_key: json!({
                "kty": "OKP", "crv": "Ed25519",
                "x": URL_SAFE_NO_PAD.encode(key.public_key().as_ref()),
            }),
            algorithm: "Ed25519".to_owned(),
            scopes: Some(vec![DeviceScope::Observe]),
        })
        .expect("pair");
    let challenge = harness
        .server
        .runtime
        .devices
        .challenge(&device.id)
        .expect("challenge");
    let session = harness
        .server
        .runtime
        .devices
        .authenticate(AuthenticateDevice {
            device_id: device.id,
            nonce: challenge.nonce.clone(),
            signature: URL_SAFE_NO_PAD.encode(key.sign(challenge.nonce.as_bytes()).as_ref()),
        })
        .expect("authenticate");
    let client = reqwest::Client::new();
    let observed = client
        .post(harness.http("/terminal/api/v1/rpc"))
        .bearer_auth(&session.token)
        .json(&json!({ "channel": "mux:listSessions", "args": [false] }))
        .send()
        .await
        .expect("observe");
    assert_eq!(observed.status(), StatusCode::OK);
    let denied = client
        .post(harness.http("/terminal/api/v1/rpc"))
        .bearer_auth(&session.token)
        .json(&json!({ "channel": "mux:createSession", "args": ["Denied"] }))
        .send()
        .await
        .expect("control");
    assert_eq!(denied.status(), StatusCode::FORBIDDEN);
    let devices = client
        .get(harness.http("/terminal/api/v1/security/devices"))
        .bearer_auth(&session.token)
        .send()
        .await
        .expect("devices");
    assert_eq!(devices.status(), StatusCode::FORBIDDEN);
    harness.server.shutdown().await;
}

#[tokio::test]
async fn process_exit_updates_terminals_in_archived_keep_running_session() {
    let harness = Harness::start(None).await;
    let principal = Principal::local("lifecycle-test".to_owned());
    let snapshot = harness.server.runtime.store.list_snapshots(false).remove(0);
    let terminal = harness.server.runtime.dispatch(
        &principal,
        "mux:createTerminal",
        &[json!({
            "sessionId": snapshot.session.id,
            "tabId": snapshot.tabs[0].id,
            "kind": "terminal",
            "title": "Short lived",
            "input": { "_tag": "TerminalInput", "kind": "terminal", "shellArgs": ["-c", "exit 0"] },
        })],
    ).expect("create terminal");
    let terminal_id = terminal["id"].as_str().expect("terminal id").to_owned();
    harness
        .server
        .runtime
        .dispatch(
            &principal,
            "mux:archiveSession",
            &[json!({ "sessionId": snapshot.session.id, "mode": "keep-running" })],
        )
        .expect("archive");
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let status = harness
                .server
                .runtime
                .store
                .get_terminal(&terminal_id)
                .map(|terminal| terminal.status);
            if status == Some(yaade_server::model::TerminalStatus::Succeeded) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("exit update");
    harness.server.shutdown().await;
}

#[tokio::test]
async fn persisted_replay_pages_and_checkpoints_recover_trimmed_terminal_output() {
    let harness = Harness::start(None).await;
    let principal = Principal::local("replay-test".to_owned());
    let cwd = std::env::current_dir().expect("cwd").display().to_string();
    let created = harness
        .server
        .runtime
        .dispatch(
            &principal,
            "terminal:create",
            &[
                json!(cwd),
                json!({
                    "command": "/bin/sh",
                    "args": ["-c", "head -c 2600000 /dev/zero | tr '\\000' x"]
                }),
            ],
        )
        .expect("create");
    let terminal_id = created["id"].as_str().expect("terminal id");
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if harness
                .server
                .runtime
                .terminal
                .inspect(terminal_id)
                .is_some_and(|terminal| {
                    terminal.status == yaade_server::terminal::TerminalProcessStatus::Exited
                })
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("terminal exit");
    let attach = harness
        .server
        .runtime
        .dispatch(
            &principal,
            "terminal:attach",
            &[json!(terminal_id), json!(0), json!("raw")],
        )
        .expect("attach");
    assert_eq!(attach["replayQuality"], "checkpoint");
    assert_eq!(attach["checkpoint"]["checkpointVersion"], 2);
    assert_eq!(attach["archiveAvailable"], true);
    let page = harness
        .server
        .runtime
        .dispatch(
            &principal,
            "terminal:readReplayPage",
            &[json!(terminal_id), json!(0), json!(64 * 1024)],
        )
        .expect("page");
    assert!(
        page["chunks"]
            .as_array()
            .is_some_and(|chunks| !chunks.is_empty())
    );
    assert!(
        page["lastSequence"]
            .as_u64()
            .is_some_and(|sequence| sequence > 0)
    );
    harness.server.shutdown().await;
}

#[tokio::test]
async fn two_websocket_clients_receive_same_live_pty_and_survive_one_disconnect() {
    let harness = Harness::start(None).await;
    let client = reqwest::Client::new();
    let create: Value = client
        .post(harness.http("/terminal/api/v1/rpc"))
        .json(&json!({
            "channel": "terminal:create",
            "args": [std::env::current_dir().expect("cwd").display().to_string(), {
                "command": "/bin/sh",
                "args": ["-c", "printf READY; sleep 2"]
            }]
        }))
        .send()
        .await
        .expect("create")
        .json()
        .await
        .expect("create json");
    let terminal_id = create["value"]["id"].as_str().expect("terminal id");
    // The capable transport owns a native Ghostty authority and replicates
    // opaque snapshot plus raw bytes; semantic diffs are not on this path.
    assert!(create["value"].get("protocolVersion").is_none());

    let mut first = modern_socket(&harness, None).await;
    for _ in 0..2 {
        let _ = json_message(&mut first).await;
    }
    let mut second = modern_socket(&harness, None).await;
    for _ in 0..2 {
        let _ = json_message(&mut second).await;
    }
    let mut second_stream = None;
    for (request, socket) in [("one", &mut first), ("two", &mut second)] {
        socket
            .send(Message::Text(
                json!({
                    "requestId": request,
                    "op": "terminal:attach",
                    "args": [terminal_id, 0, "raw"]
                })
                .to_string()
                .into(),
            ))
            .await
            .expect("attach");
        let result = json_message(socket).await;
        assert_eq!(result["ok"], true);
        assert!(result["value"]["outputChunks"].as_array().is_some());
        if request == "two" {
            second_stream = Some((
                result["value"]["streamId"].as_u64().expect("stream id"),
                result["value"]["streamEpoch"]
                    .as_u64()
                    .expect("stream epoch"),
            ));
        }
        for expected_kind in [4_u8, 5_u8] {
            let frame = tokio::time::timeout(Duration::from_secs(2), socket.next())
                .await
                .expect("attach frame timeout")
                .expect("socket open")
                .expect("attach frame");
            let Message::Binary(frame) = frame else {
                panic!("expected binary attach frame")
            };
            assert_eq!(&frame[..3], b"PD\x04");
            assert_eq!(frame[3], expected_kind);
        }
    }
    let (stream_id, stream_epoch) = second_stream.expect("second stream");
    let mut scrollback = vec![0_u8; 49];
    scrollback[..4].copy_from_slice(b"PD\x04\x09");
    scrollback[6..8].copy_from_slice(&36_u16.to_be_bytes());
    scrollback[8..16].copy_from_slice(&stream_id.to_be_bytes());
    scrollback[16..24].copy_from_slice(&stream_epoch.to_be_bytes());
    scrollback[24..32].copy_from_slice(&1_u64.to_be_bytes());
    scrollback[32..36].copy_from_slice(&13_u32.to_be_bytes());
    scrollback[36..44].copy_from_slice(&0_u64.to_be_bytes());
    scrollback[44..48].copy_from_slice(&(64_u32 * 1024).to_be_bytes());
    second
        .send(Message::Binary(scrollback.into()))
        .await
        .expect("scrollback request");
    let mut kinds = Vec::new();
    while kinds.last() != Some(&11) {
        let frame = tokio::time::timeout(Duration::from_secs(2), second.next())
            .await
            .expect("scrollback timeout")
            .expect("socket open")
            .expect("scrollback frame");
        let Message::Binary(frame) = frame else {
            panic!("expected binary scrollback frame")
        };
        kinds.push(frame[3]);
    }
    assert_eq!(kinds.first(), Some(&9));
    assert!(kinds.contains(&10));

    first.close(None).await.expect("close first");
    second
        .send(Message::Text("ping".into()))
        .await
        .expect("ping");
    let pong = tokio::time::timeout(Duration::from_secs(2), second.next())
        .await
        .expect("pong timeout")
        .expect("socket open")
        .expect("pong");
    assert_eq!(pong, Message::Text("pong".into()));
    harness.server.shutdown().await;
}
