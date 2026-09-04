use std::{
    collections::{HashMap, HashSet},
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

#[cfg(test)]
use std::collections::VecDeque;

use axum::{
    Json, Router,
    body::{Body, Bytes},
    extract::{
        DefaultBodyLimit, Path as AxumPath, Query, State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    http::{HeaderMap, HeaderValue, Method, Request, StatusCode, Uri, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{any, delete, get, post},
};
use futures_util::{
    SinkExt as _, StreamExt as _,
    stream::{SplitSink, SplitStream},
};
#[cfg(feature = "embedded-web")]
use include_dir::{Dir, include_dir};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest as _, Sha256};
use subtle::ConstantTimeEq as _;
use tokio::{
    net::TcpListener,
    sync::{Semaphore, broadcast},
};
use uuid::Uuid;

use crate::{
    config::{HostConfig, is_loopback_hostname},
    connection_outbound::{ConnectionOutbound, NextOutbound},
    device_auth::{AuthenticateDevice, DeviceAuthError, PairDevice},
    event_hub::{HubMessage, TerminalSubscriber},
    model::now_iso,
    outbound_mailbox::OutboundFrameKind,
    runtime::{HostRuntime, Principal, RuntimeError},
    terminal::capture_process_identity,
    wire::{HostEvent, HostRpcRequest, MAX_WS_PAYLOAD_BYTES, TerminalWsAck, TerminalWsCommand},
};

const MAX_JSON_BODY_BYTES: usize = 2 * 1024 * 1024;
const MAX_WS_COMMAND_QUEUE: usize = 64;
const MAX_INFLIGHT_RPC: usize = 32;
const MAX_PENDING_AUTH: usize = 64;

#[cfg(feature = "embedded-web")]
static EMBEDDED_WEB: Dir<'static> = include_dir!("$CARGO_MANIFEST_DIR/../../apps/web/dist");

#[derive(Clone)]
struct AppState {
    runtime: Arc<HostRuntime>,
    rpc_limit: Arc<Semaphore>,
    auth_limit: Arc<Semaphore>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WsQuery {
    protocol: Option<u8>,
    client_id: Option<String>,
    token: Option<String>,
    since: Option<u64>,
}

pub struct RunningServer {
    pub runtime: Arc<HostRuntime>,
    pub address: SocketAddr,
    task: tokio::task::JoinHandle<()>,
}

impl RunningServer {
    pub async fn shutdown(self) {
        self.runtime.shutdown();
        self.task.abort();
        let _ = self.task.await;
        let _ = std::fs::remove_file(self.runtime.config.data_dir.join("runtime.json"));
    }

    pub async fn wait(self) {
        let _ = self.task.await;
        let manifest = self.runtime.config.data_dir.join("runtime.json");
        if let Ok(value) = std::fs::read(&manifest)
            && serde_json::from_slice::<Value>(&value)
                .ok()
                .and_then(|value| {
                    value
                        .get("serverEpoch")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                })
                .as_deref()
                == Some(self.runtime.identity.server_epoch.as_str())
        {
            let _ = std::fs::remove_file(manifest);
        }
    }
}

pub async fn serve(mut config: HostConfig) -> Result<RunningServer, Box<dyn std::error::Error>> {
    let listener = bind_preferred(&config.host, config.port).await?;
    let address = listener.local_addr()?;
    config.port = address.port();
    let runtime = HostRuntime::start(config)?;
    write_runtime_manifest(&runtime, address.port())?;
    let state = AppState {
        runtime: Arc::clone(&runtime),
        rpc_limit: Arc::new(Semaphore::new(MAX_INFLIGHT_RPC)),
        auth_limit: Arc::new(Semaphore::new(MAX_PENDING_AUTH)),
    };
    let task_router = crate::tasks::router(Arc::clone(&runtime.store))?;
    let agent_router = crate::agents::router(Arc::clone(&runtime))?;
    let terminal_router = Router::new()
        .route("/health", get(health))
        .route("/api/v1/readiness", get(readiness))
        .route("/api/v1/system", get(system))
        .route("/api/v1/status", get(diagnostics))
        .route("/api/v1/metrics", get(metrics))
        .route("/api/v1/diagnostics", get(diagnostics))
        .route("/api/v1/security/pair", post(pair_device))
        .route("/api/v1/security/challenge", post(device_challenge))
        .route("/api/v1/security/session", post(device_session))
        .route(
            "/api/v1/security/session/rotate",
            post(rotate_device_session),
        )
        .route("/api/v1/security/pairing-code", post(pairing_code))
        .route("/api/v1/security/devices", get(list_devices))
        .route(
            "/api/v1/security/devices/{device_id}",
            delete(revoke_device),
        )
        .route("/api/v1/rpc", post(rpc))
        .route("/ws", get(websocket));
    let router = Router::new()
        .nest("/terminal", terminal_router)
        .nest("/tasks", task_router)
        .nest("/agents", agent_router)
        .fallback(any(fallback))
        .layer(DefaultBodyLimit::max(MAX_JSON_BODY_BYTES))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            request_policy,
        ))
        .with_state(state);
    println!(
        "[host-server] listening on http://{}:{}",
        runtime.config.host,
        address.port()
    );
    let shutdown_runtime = Arc::clone(&runtime);
    let shutdown = async move {
        shutdown_signal().await;
        shutdown_runtime.shutdown();
    };
    let task = tokio::spawn(async move {
        if let Err(error) = axum::serve(listener, router)
            .with_graceful_shutdown(shutdown)
            .await
        {
            eprintln!("[host-server] {error}");
        }
    });
    Ok(RunningServer {
        runtime,
        address,
        task,
    })
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let terminate = signal(SignalKind::terminate());
        if let Ok(mut terminate) = terminate {
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {},
                _ = terminate.recv() => {},
            }
            return;
        }
    }
    let _ = tokio::signal::ctrl_c().await;
}

async fn bind_preferred(host: &str, preferred: u16) -> std::io::Result<TcpListener> {
    if preferred == 0 {
        return TcpListener::bind((host, 0)).await;
    }
    let mut last_error = None;
    for offset in 0..50_u16 {
        match TcpListener::bind((host, preferred.saturating_add(offset))).await {
            Ok(listener) => return Ok(listener),
            Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => last_error = Some(error),
            Err(error) => return Err(error),
        }
    }
    Err(last_error.unwrap_or_else(|| std::io::Error::other("no available port")))
}

fn is_namespaced_api(path: &str) -> bool {
    path.starts_with("/terminal/api/")
        || path == "/terminal/health"
        || path.starts_with("/tasks/api/")
        || path == "/tasks/health"
        || path.starts_with("/agents/v1/")
}

async fn request_policy(
    State(state): State<AppState>,
    request: Request<Body>,
    next: Next,
) -> Response {
    let pathname = request.uri().path();
    let is_api = is_namespaced_api(pathname);
    let origin = request
        .headers()
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let cors_allowed = origin
        .as_deref()
        .is_some_and(|origin| allowed_cors_origin(origin, &state.runtime.config.cors_origins));
    if is_api && request.method() == Method::OPTIONS {
        if origin.is_some() && !cors_allowed {
            return StatusCode::FORBIDDEN.into_response();
        }
        let mut response = StatusCode::NO_CONTENT.into_response();
        add_cors_headers(&mut response, origin.as_deref(), cors_allowed);
        return response;
    }
    if is_api
        && origin.as_deref().is_some_and(|origin| {
            !allowed_http_origin(
                origin,
                &state.runtime.config.host,
                &state.runtime.config.cors_origins,
            )
        })
    {
        return json_response(
            StatusCode::FORBIDDEN,
            json!({ "error": { "code": "ORIGIN_DENIED", "message": "origin is not allowed", "details": {} } }),
        );
    }
    let requires_shared_auth = pathname.starts_with("/tasks/api/")
        || (pathname.starts_with("/agents/v1/")
            && pathname != "/agents/v1/health"
            && !pathname.ends_with("/stream"));
    if requires_shared_auth
        && request_principal(&state.runtime, request.headers(), request.uri(), None).is_none()
    {
        return unauthorized();
    }
    let mut response = next.run(request).await;
    if is_api {
        add_cors_headers(&mut response, origin.as_deref(), cors_allowed);
    }
    response
}

fn add_cors_headers(response: &mut Response, origin: Option<&str>, allowed: bool) {
    if !allowed {
        return;
    }
    if let Some(origin) = origin.and_then(|origin| HeaderValue::from_str(origin).ok()) {
        response
            .headers_mut()
            .insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
        response
            .headers_mut()
            .insert(header::VARY, HeaderValue::from_static("Origin"));
        response.headers_mut().insert(
            header::ACCESS_CONTROL_ALLOW_HEADERS,
            HeaderValue::from_static("content-type, authorization, x-yaade-token"),
        );
        response.headers_mut().insert(
            header::ACCESS_CONTROL_ALLOW_METHODS,
            HeaderValue::from_static("GET, POST, PUT, PATCH, DELETE, OPTIONS"),
        );
    }
}

async fn health(State(state): State<AppState>) -> Response {
    let database = state.runtime.store.health();
    json_response(
        StatusCode::OK,
        json!({
            "status": "ok",
            "version": env!("CARGO_PKG_VERSION"),
            "identity": state.runtime.identity,
            "health": {
                "status": if database { "healthy" } else { "unhealthy" },
                "database": {
                    "status": if database { "healthy" } else { "degraded" },
                    "message": if database { "SQLite WAL is available" } else { "SQLite probe failed" },
                },
                "eventLoop": { "status": "healthy", "message": "health request served on the HTTP event loop" },
                "storage": { "status": "healthy", "message": "runtime storage is available" },
                "connectedClients": state.runtime.events.subscriber_count().saturating_sub(1),
                "runningTerminals": state.runtime.running_terminal_count(),
            }
        }),
    )
}

async fn readiness(State(state): State<AppState>) -> Response {
    let ready = state.runtime.store.health();
    json_response(
        if ready {
            StatusCode::OK
        } else {
            StatusCode::SERVICE_UNAVAILABLE
        },
        json!({
            "status": if ready { "ready" } else { "not-ready" },
            "store": if ready { "available" } else { "unavailable" },
            "terminalRuntime": "available",
        }),
    )
}

async fn system(State(state): State<AppState>, headers: HeaderMap, uri: Uri) -> Response {
    let Some(_) = request_principal(&state.runtime, &headers, &uri, None) else {
        return unauthorized();
    };
    json_response(
        StatusCode::OK,
        json!({
            "name": "YAADE",
            "version": env!("CARGO_PKG_VERSION"),
            "protocolVersion": 2,
            "identity": state.runtime.identity,
            "capabilities": state.runtime.capabilities,
            "serverId": state.runtime.identity.server_id,
            "serverEpoch": state.runtime.identity.server_epoch,
            "launchConfig": state.runtime.config.launch_config,
            "homeDir": state.runtime.home_dir,
            "machineHostname": state.runtime.machine_hostname,
        }),
    )
}

async fn diagnostics(State(state): State<AppState>, headers: HeaderMap, uri: Uri) -> Response {
    let Some(_) = request_principal(&state.runtime, &headers, &uri, None) else {
        return unauthorized();
    };
    json_response(
        StatusCode::OK,
        json!({
            "generatedAt": now_iso(),
            "identity": state.runtime.identity,
            "config": {
                "host": state.runtime.config.host,
                "port": state.runtime.config.port,
                "features": { "terminalCheckpoints": state.runtime.config.features.terminal_checkpoints },
            },
            "health": {
                "status": if state.runtime.store.health() { "healthy" } else { "unhealthy" },
                "database": { "status": if state.runtime.store.health() { "healthy" } else { "degraded" } },
                "connectedClients": state.runtime.events.subscriber_count().saturating_sub(1),
                "runningTerminals": state.runtime.running_terminal_count(),
            },
            "memory": {
                "terminalRuntime": state.runtime.terminal.runtime_diagnostics(),
                "terminalTransport": ConnectionOutbound::global_diagnostics(),
                "terminalHistory": state.runtime.terminal.history_capacity_diagnostics(),
            },
            "devices": state.runtime.devices.list().unwrap_or_default().into_iter().map(|device| json!({
                "id": device.id,
                "name": device.name,
                "scopes": device.scopes,
                "revokedAt": device.revoked_at,
            })).collect::<Vec<_>>(),
            "capabilities": state.runtime.capabilities,
        }),
    )
}

async fn metrics(State(state): State<AppState>, headers: HeaderMap, uri: Uri) -> Response {
    let Some(_) = request_principal(&state.runtime, &headers, &uri, None) else {
        return unauthorized();
    };
    let terminal = state.runtime.terminal.runtime_diagnostics();
    let history = state.runtime.terminal.history_capacity_diagnostics();
    let transport = ConnectionOutbound::global_diagnostics();
    json_response(
        StatusCode::OK,
        json!({
            "version": 1,
            "sessions": {
                "active": terminal.terminal_sessions_active,
                "parked": terminal.terminal_sessions_parked,
                "attachedClients": terminal.terminal_clients_attached,
            },
            "pty": {
                "bytesReadTotal": terminal.pty_bytes_read_total,
                "bytesWrittenTotal": terminal.pty_bytes_written_total,
            },
            "snapshots": {
                "total": terminal.terminal_snapshots_total,
                "bytesTotal": terminal.terminal_snapshot_bytes,
                "durationNanosecondsTotal": terminal.terminal_snapshot_duration_ns_total,
            },
            "history": {
                "ingestQueueBytes": history.ingest_queue_bytes,
                "bytesAcceptedTotal": history.history_bytes_accepted_total,
                "ingestRejectionsTotal": history.history_ingest_rejections_total,
            },
            "transport": transport,
        }),
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceChallengeRequest {
    device_id: String,
}

async fn pair_device(State(state): State<AppState>, Json(input): Json<PairDevice>) -> Response {
    match state.runtime.devices.pair(input) {
        Ok(device) => json_response(StatusCode::CREATED, json!(device)),
        Err(error) => device_error(error, StatusCode::BAD_REQUEST, "PAIRING_FAILED"),
    }
}

async fn device_challenge(
    State(state): State<AppState>,
    Json(input): Json<DeviceChallengeRequest>,
) -> Response {
    match state.runtime.devices.challenge(&input.device_id) {
        Ok(challenge) => json_response(StatusCode::OK, json!(challenge)),
        Err(error) => device_error(error, StatusCode::UNAUTHORIZED, "DEVICE_AUTH_FAILED"),
    }
}

async fn device_session(
    State(state): State<AppState>,
    Json(input): Json<AuthenticateDevice>,
) -> Response {
    match state.runtime.devices.authenticate(input) {
        Ok(session) => json_response(StatusCode::OK, json!(session)),
        Err(error) => device_error(error, StatusCode::UNAUTHORIZED, "DEVICE_AUTH_FAILED"),
    }
}

async fn pairing_code(State(state): State<AppState>, headers: HeaderMap, uri: Uri) -> Response {
    let Some(principal) = request_principal(&state.runtime, &headers, &uri, None) else {
        return unauthorized();
    };
    if !principal.local_admin {
        return scope_denied("admin pairing requires a local administrator");
    }
    match state.runtime.devices.create_pairing_code() {
        Ok(code) => json_response(StatusCode::CREATED, json!(code)),
        Err(error) => device_error(error, StatusCode::BAD_REQUEST, "PAIRING_FAILED"),
    }
}

async fn list_devices(State(state): State<AppState>, headers: HeaderMap, uri: Uri) -> Response {
    let Some(principal) = request_principal(&state.runtime, &headers, &uri, None) else {
        return unauthorized();
    };
    if !principal.can_admin {
        return scope_denied("admin scope required");
    }
    match state.runtime.devices.list() {
        Ok(devices) => json_response(StatusCode::OK, json!(devices)),
        Err(error) => device_error(error, StatusCode::INTERNAL_SERVER_ERROR, "OPERATION_FAILED"),
    }
}

async fn revoke_device(
    State(state): State<AppState>,
    AxumPath(device_id): AxumPath<String>,
    headers: HeaderMap,
    uri: Uri,
) -> Response {
    let Some(principal) = request_principal(&state.runtime, &headers, &uri, None) else {
        return unauthorized();
    };
    if !principal.can_admin {
        return scope_denied("admin scope required");
    }
    match state.runtime.devices.revoke(&device_id) {
        Ok(_) => {
            state
                .runtime
                .events
                .emit("security:device-revoked", vec![json!(device_id)]);
            StatusCode::NO_CONTENT.into_response()
        }
        Err(error) => device_error(error, StatusCode::INTERNAL_SERVER_ERROR, "OPERATION_FAILED"),
    }
}

async fn rotate_device_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
) -> Response {
    let Some(principal) = request_principal(&state.runtime, &headers, &uri, None) else {
        return unauthorized();
    };
    if !principal.can_control {
        return scope_denied("route requires control capability");
    }
    let Some(token) = bearer_token(&headers).or_else(|| query_token(&uri)) else {
        return device_error(
            DeviceAuthError::Unauthorized("unknown session".to_owned()),
            StatusCode::UNAUTHORIZED,
            "DEVICE_AUTH_FAILED",
        );
    };
    match state.runtime.devices.rotate(&token) {
        Ok(session) => json_response(StatusCode::OK, json!(session)),
        Err(error) => device_error(error, StatusCode::UNAUTHORIZED, "DEVICE_AUTH_FAILED"),
    }
}

async fn rpc(State(state): State<AppState>, headers: HeaderMap, uri: Uri, body: Bytes) -> Response {
    let Ok(_permit) = Arc::clone(&state.rpc_limit).try_acquire_owned() else {
        return json_response(
            StatusCode::SERVICE_UNAVAILABLE,
            json!({
                "error": {
                    "code": "HOST_BUSY",
                    "message": format!("too many in-flight RPCs (max {MAX_INFLIGHT_RPC})"),
                    "details": { "inflight": MAX_INFLIGHT_RPC },
                }
            }),
        );
    };
    let request = match serde_json::from_slice::<HostRpcRequest>(&body) {
        Ok(request) => request,
        Err(error) => {
            return json_response(
                StatusCode::BAD_REQUEST,
                json!({
                    "error": {
                        "code": "INVALID_RPC_PAYLOAD",
                        "message": format!("invalid rpc body: {error}"),
                        "details": {},
                    }
                }),
            );
        }
    };
    let Some(principal) = request_principal(
        &state.runtime,
        &headers,
        &uri,
        Some(request.client_id.as_str()),
    ) else {
        return unauthorized();
    };
    match state
        .runtime
        .dispatch(&principal, &request.channel, &request.args)
    {
        Ok(value) => json_response(StatusCode::OK, json!({ "value": value })),
        Err(error) => runtime_error(error),
    }
}

async fn websocket(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Query(query): Query<WsQuery>,
    headers: HeaderMap,
) -> Response {
    if !allowed_websocket_origin(
        headers
            .get(header::ORIGIN)
            .and_then(|value| value.to_str().ok()),
        headers
            .get(header::HOST)
            .and_then(|value| value.to_str().ok()),
        &state.runtime.config.cors_origins,
    ) {
        return StatusCode::FORBIDDEN.into_response();
    }
    if query.protocol.unwrap_or(1) != 2
        && principal_for_token(
            &state.runtime,
            query.token.as_deref(),
            format!("ws-admission-{}", Uuid::new_v4()),
        )
        .is_none()
    {
        return unauthorized();
    }
    ws.max_message_size(MAX_WS_PAYLOAD_BYTES)
        .max_frame_size(MAX_WS_PAYLOAD_BYTES)
        .on_upgrade(move |socket| handle_socket(socket, state.runtime, state.auth_limit, query))
}

async fn handle_socket(
    socket: WebSocket,
    runtime: Arc<HostRuntime>,
    auth_limit: Arc<Semaphore>,
    query: WsQuery,
) {
    let protocol = query.protocol.unwrap_or(1);
    if protocol != 1 && protocol != 2 {
        let mut socket = socket;
        let _ = socket
            .send(Message::Close(Some(axum::extract::ws::CloseFrame {
                code: 4002,
                reason: "incompatible protocol".into(),
            })))
            .await;
        return;
    }
    let (mut sender, mut receiver) = socket.split();
    let connection_id = query
        .client_id
        .as_deref()
        .filter(|value| !value.is_empty() && value.len() <= 128)
        .map_or_else(
            || format!("ws-{}", Uuid::new_v4()),
            |value| format!("ws-{value}-{}", Uuid::new_v4()),
        );
    let principal = if protocol == 2 {
        let auth_permit = if runtime.config.auth_token.is_some() {
            match auth_limit.try_acquire_owned() {
                Ok(permit) => Some(permit),
                Err(_) => {
                    let _ = close_socket(&mut sender, 1013, "too many unauthenticated connections")
                        .await;
                    return;
                }
            }
        } else {
            None
        };
        let authenticated =
            authenticate_modern(&runtime, &mut sender, &mut receiver, &connection_id).await;
        drop(auth_permit);
        match authenticated {
            Some(principal) => principal,
            None => return,
        }
    } else {
        match principal_for_token(&runtime, query.token.as_deref(), connection_id.clone()) {
            Some(principal) => principal,
            None => {
                let _ = close_socket(&mut sender, 4003, "authentication required").await;
                return;
            }
        }
    };
    let mut events = runtime.events.subscribe();
    let mut snapshot_sequence = 0;
    if protocol == 2 {
        if send_terminal_frame(
            &mut sender,
            terminal_protocol::FrameType::Hello,
            0,
            0,
            0,
            &json!({
                "type": "protocol:hello",
                "identity": runtime.identity,
                "capabilities": runtime.capabilities,
            }),
        )
        .await
        .is_err()
        {
            return;
        }
        let snapshot = runtime.snapshot();
        snapshot_sequence = snapshot
            .get("cursor")
            .and_then(|cursor| cursor.get("sequence"))
            .and_then(Value::as_u64)
            .unwrap_or(0);
        if send_json(&mut sender, &snapshot).await.is_err() {
            return;
        }
    } else {
        let replay = runtime.events.replay_window(query.since.unwrap_or(0));
        if replay.history_evicted {
            let gap = HostEvent {
                protocol_version: 1,
                server_id: None,
                server_epoch: None,
                sequence: replay.replay_floor.saturating_sub(1),
                channel: Arc::from("protocol:replay-gap"),
                args: Arc::from(vec![
                    json!(replay.replay_floor),
                    json!(replay.last_sequence),
                ]),
            };
            if send_json(&mut sender, &gap).await.is_err() {
                return;
            }
        }
        for event in replay.events {
            if send_json(&mut sender, &event.legacy()).await.is_err() {
                return;
            }
        }
    }

    let outbound = ConnectionOutbound::new(protocol, terminal_flow_limit());
    let terminal_subscriber: Arc<dyn TerminalSubscriber> = outbound.clone();
    let writer_outbound = Arc::clone(&outbound);
    let writer = tokio::spawn(async move {
        socket_writer(sender, writer_outbound).await;
    });
    let mut attached = HashSet::<String>::new();
    let mut raw = HashSet::<String>::new();
    let mut terminal_streams = HashMap::<u64, (String, u64, u64, u64)>::new();
    let mut queued_commands = 0_usize;

    loop {
        tokio::select! {
            message = receiver.next() => {
                let Some(Ok(message)) = message else { break; };
                match message {
                    Message::Text(text) if text.as_str() == "ping" => {
                        if protocol == 1 && !outbound.enqueue_text("pong") { break; }
                    }
                    Message::Text(text) => {
                        if protocol == 2 {
                            outbound.close(1002, "capable terminal control must use binary protocol-v4 frames");
                            break;
                        }
                        let Ok(value) = serde_json::from_str::<Value>(text.as_str()) else { continue; };
                        if let Ok(ack) = serde_json::from_value::<TerminalWsAck>(value.clone())
                            && ack.kind == "terminal:ack"
                        {
                            outbound.acknowledge(&ack.terminal_id, ack.sequence);
                            continue;
                        }
                        let Ok(command) = serde_json::from_value::<TerminalWsCommand>(value) else { continue; };
                        if command.request_id.is_empty() || !is_realtime_op(&command.op) { continue; }
                        if queued_commands >= MAX_WS_COMMAND_QUEUE {
                            if !outbound.enqueue_reliable(&json!({
                                "type": "terminal:result",
                                "requestId": command.request_id,
                                "ok": false,
                                "error": { "code": "HOST_BUSY", "message": "too many in-flight terminal commands" },
                            })) { break; }
                            continue;
                        }
                        queued_commands += 1;
                        if command.op == "terminal:attach"
                            && let Some(id) = command.args.first().and_then(Value::as_str)
                        {
                            attached.insert(id.to_owned());
                            let mode = command.args.get(2).and_then(Value::as_str).unwrap_or("both");
                            if mode == "raw" || mode == "both" { raw.insert(id.to_owned()); }
                            let acknowledged = command.args.get(1).and_then(Value::as_u64).unwrap_or(0);
                            outbound.attach(id, acknowledged);
                            if raw.contains(id) {
                                runtime.events.attach_terminal(
                                    id,
                                    &principal.connection_id,
                                    &terminal_subscriber,
                                );
                            }
                        } else if command.op == "terminal:detach"
                            && let Some(id) = command.args.first().and_then(Value::as_str)
                        {
                            attached.remove(id);
                            raw.remove(id);
                            terminal_streams.retain(|_, (terminal_id, _, _, _)| terminal_id != id);
                            outbound.detach(id);
                            runtime.events.detach_terminal(id, &principal.connection_id);
                        }
                        let mut attach_snapshot_payload = None;
                        let result = if protocol == 2 && command.op == "terminal:attach" {
                            runtime
                                .attach_terminal_binary(&principal, &command.args)
                                .and_then(|mut attach| {
                                    attach_snapshot_payload = attach.checkpoint.as_mut().map(
                                        |checkpoint| {
                                            std::mem::take(&mut checkpoint.snapshot_bytes.0)
                                        },
                                    );
                                    let mut value = serde_json::to_value(attach)?;
                                    if let Some(object) = value.as_object_mut() {
                                        object.insert(
                                            "ownerId".to_owned(),
                                            json!(runtime.identity.server_id),
                                        );
                                        object.insert(
                                            "ownerEpoch".to_owned(),
                                            json!(runtime.identity.server_epoch),
                                        );
                                    }
                                    Ok(value)
                                })
                        } else {
                            runtime.dispatch(&principal, &command.op, &command.args)
                        };
                        queued_commands = queued_commands.saturating_sub(1);
                        let mut attach_snapshot = None;
                        let mut attach_stream = None;
                        let response = match result {
                            Ok(value) => {
                                if command.op == "terminal:attach" {
                                    let last_sequence = value
                                        .get("lastSequence")
                                        .and_then(Value::as_u64)
                                        .unwrap_or(0);
                                    attach_snapshot = Some(last_sequence);
                                    attach_stream = value
                                        .get("streamId")
                                        .and_then(Value::as_u64)
                                        .zip(value.get("streamEpoch").and_then(Value::as_u64));
                                    if let Some((stream_id, epoch)) = attach_stream
                                        && let Some(id) = command.args.first().and_then(Value::as_str)
                                    {
                                        terminal_streams.insert(stream_id, (id.to_owned(), epoch, 0, 0));
                                    }
                                }
                                json!({
                                    "type": "terminal:result",
                                    "requestId": command.request_id,
                                    "ok": true,
                                    "value": value,
                                })
                            },
                            Err(error) => {
                                if command.op == "terminal:attach"
                                    && let Some(id) = command.args.first().and_then(Value::as_str)
                                {
                                    attached.remove(id);
                                    raw.remove(id);
                                    outbound.detach(id);
                                    runtime.events.detach_terminal(id, &principal.connection_id);
                                }
                                json!({
                                    "type": "terminal:result",
                                    "requestId": command.request_id,
                                    "ok": false,
                                    "error": { "code": error.wire_code(), "message": error.to_string() },
                                })
                            }
                        };
                        let accepted = if command.op == "terminal:attach" {
                            command.args.first().and_then(Value::as_str).is_some_and(|id| {
                                outbound.enqueue_attach_result(
                                    id,
                                    attach_snapshot,
                                    attach_stream,
                                    attach_snapshot_payload,
                                    &response,
                                )
                            })
                        } else {
                            outbound.enqueue_reliable(&response)
                        };
                        if !accepted { break; }
                    }
                    Message::Binary(data) => {
                        let mut input = bytes::BytesMut::from(data.as_ref());
                        let decoded = terminal_protocol::Codec::default().decode(&mut input);
                        let Ok(Some(frame)) = decoded else {
                            outbound.close(1002, "invalid terminal binary frame");
                            break;
                        };
                        if !input.is_empty() {
                            outbound.close(1002, "multiple terminal frames in one websocket message");
                            break;
                        }
                        if frame.kind == terminal_protocol::FrameType::Ping {
                            if !outbound.enqueue_protocol_frame(
                                terminal_protocol::FrameType::Pong,
                                frame.stream_id,
                                frame.position.epoch,
                                frame.position.sequence,
                                bytes::Bytes::new(),
                            ) { break; }
                            continue;
                        }
                        if frame.kind == terminal_protocol::FrameType::Attach {
                            if !handle_binary_attach(
                                &runtime,
                                &principal,
                                &outbound,
                                &terminal_subscriber,
                                &mut attached,
                                &mut raw,
                                &mut terminal_streams,
                                frame,
                            ) { break; }
                            continue;
                        }
                        let Some((terminal_id, epoch, input_position, control_position)) = terminal_streams.get_mut(&frame.stream_id) else {
                            outbound.close(1002, "unknown terminal stream");
                            break;
                        };
                        if frame.position.epoch != *epoch {
                            outbound.close(1002, "stale terminal stream epoch");
                            break;
                        }
                        if frame.kind == terminal_protocol::FrameType::Pong {
                            outbound.acknowledge(terminal_id, frame.position.sequence);
                            continue;
                        }
                        if frame.kind == terminal_protocol::FrameType::ResyncRequest {
                            if !outbound.enqueue_protocol_frame(
                                terminal_protocol::FrameType::ResyncBegin,
                                frame.stream_id,
                                frame.position.epoch,
                                frame.position.sequence,
                                bytes::Bytes::new(),
                            ) { break; }
                            continue;
                        }
                        if matches!(frame.kind, terminal_protocol::FrameType::Ready | terminal_protocol::FrameType::Detach) {
                            let Ok(command) = serde_json::from_slice::<TerminalWsCommand>(&frame.payload) else {
                                outbound.close(1002, "invalid terminal control payload");
                                break;
                            };
                            let expected_op = if frame.kind == terminal_protocol::FrameType::Ready {
                                "terminal:ready"
                            } else {
                                "terminal:detach"
                            };
                            if command.request_id.is_empty() || command.op != expected_op {
                                outbound.close(1002, "mismatched terminal control operation");
                                break;
                            }
                            let result = runtime.dispatch(
                                &principal,
                                expected_op,
                                &[json!(terminal_id)],
                            );
                            if frame.kind == terminal_protocol::FrameType::Detach {
                                attached.remove(terminal_id);
                                raw.remove(terminal_id);
                                runtime.events.detach_terminal(terminal_id, &principal.connection_id);
                            }
                            let response = match result {
                                Ok(value) => json!({
                                    "type": "terminal:result",
                                    "requestId": command.request_id,
                                    "ok": true,
                                    "value": value,
                                }),
                                Err(error) => json!({
                                    "type": "terminal:result",
                                    "requestId": command.request_id,
                                    "ok": false,
                                    "error": { "code": error.wire_code(), "message": error.to_string() },
                                }),
                            };
                            let payload = match serde_json::to_vec(&response) {
                                Ok(payload) => bytes::Bytes::from(payload),
                                Err(_) => {
                                    outbound.close(1011, "terminal control response serialization failed");
                                    break;
                                }
                            };
                            let response_kind = if response.get("ok").and_then(Value::as_bool) == Some(true) {
                                terminal_protocol::FrameType::ControlAck
                            } else {
                                terminal_protocol::FrameType::Error
                            };
                            if !outbound.enqueue_protocol_frame(
                                response_kind,
                                frame.stream_id,
                                frame.position.epoch,
                                frame.position.sequence,
                                payload,
                            ) { break; }
                            if frame.kind == terminal_protocol::FrameType::Detach {
                                outbound.detach(terminal_id);
                                terminal_streams.remove(&frame.stream_id);
                            }
                            continue;
                        }
                        let result = match frame.kind {
                            terminal_protocol::FrameType::Input => {
                                let expected = input_position.saturating_add(frame.payload.len() as u64);
                                if frame.position.sequence != expected {
                                    outbound.close(1002, "terminal input sequence gap");
                                    break;
                                }
                                *input_position = expected;
                                runtime.terminal.authorize_and_write(
                                    terminal_id,
                                    &principal.principal_id,
                                    &principal.connection_id,
                                    None,
                                    frame.payload,
                                )
                            }
                            terminal_protocol::FrameType::ScrollbackBegin
                                if frame.payload.len() == 13 =>
                            {
                                let expected = control_position.saturating_add(1);
                                if frame.position.sequence != expected {
                                    outbound.close(1002, "terminal control sequence gap");
                                    break;
                                }
                                let cursor = u64::from_be_bytes(
                                    frame.payload[..8].try_into().expect("validated slice"),
                                );
                                let max_bytes = u32::from_be_bytes(
                                    frame.payload[8..12].try_into().expect("validated slice"),
                                ) as usize;
                                let reverse = match frame.payload[12] {
                                    0 => false,
                                    1 => true,
                                    _ => {
                                        outbound.close(1002, "invalid scrollback direction");
                                        break;
                                    }
                                };
                                if !(1..=256 * 1024).contains(&max_bytes) {
                                    outbound.close(1002, "invalid scrollback byte limit");
                                    break;
                                }
                                *control_position = expected;
                                let terminal = Arc::clone(&runtime.terminal);
                                let outbound = Arc::clone(&outbound);
                                let terminal_id = terminal_id.clone();
                                let stream_id = frame.stream_id;
                                let stream_epoch = frame.position.epoch;
                                tokio::spawn(async move {
                                    let page = tokio::task::spawn_blocking(move || {
                                        terminal.read_replay_page(
                                            &terminal_id,
                                            cursor,
                                            Some(max_bytes),
                                            reverse,
                                        )
                                    })
                                    .await;
                                    let codec = terminal_protocol::Codec::default();
                                    let page = match page {
                                        Ok(Ok(page)) => page,
                                        _ => {
                                            if let Ok(error_end) = terminal_protocol::Frame::new(
                                                terminal_protocol::FrameType::ScrollbackEnd,
                                                0,
                                                stream_id,
                                                terminal_protocol::StreamPosition {
                                                    epoch: stream_epoch,
                                                    sequence: cursor,
                                                },
                                                bytes::Bytes::from_static(&[2]),
                                            )
                                            .and_then(|frame| codec.encode(frame))
                                            {
                                                let _ = outbound
                                                    .enqueue_binary_reliable(error_end.coalesce());
                                            }
                                            return;
                                        }
                                    };
                                    let mut frames = Vec::new();
                                    let begin = terminal_protocol::Frame::new(
                                        terminal_protocol::FrameType::ScrollbackBegin,
                                        0,
                                        stream_id,
                                        terminal_protocol::StreamPosition {
                                            epoch: stream_epoch,
                                            sequence: expected,
                                        },
                                        bytes::Bytes::new(),
                                    )
                                    .and_then(|frame| codec.encode(frame));
                                    let Ok(begin) = begin else { return };
                                    frames.push(begin.coalesce());
                                    let (next_sequence, complete) = if let Some(page) = page {
                                        let mut sequence = page.first_sequence;
                                        for (index, chunk) in page.chunks.into_iter().enumerate() {
                                            if index > 0 {
                                                sequence = sequence
                                                    .saturating_add(chunk.0.len() as u64);
                                            }
                                            let encoded = terminal_protocol::Frame::new(
                                                terminal_protocol::FrameType::ScrollbackChunk,
                                                0,
                                                stream_id,
                                                terminal_protocol::StreamPosition {
                                                    epoch: stream_epoch,
                                                    sequence,
                                                },
                                                chunk.0,
                                            )
                                            .and_then(|frame| codec.encode(frame));
                                            let Ok(encoded) = encoded else { return };
                                            frames.push(encoded.coalesce());
                                        }
                                        (page.next_sequence, page.complete)
                                    } else {
                                        (cursor, true)
                                    };
                                    let end = terminal_protocol::Frame::new(
                                        terminal_protocol::FrameType::ScrollbackEnd,
                                        0,
                                        stream_id,
                                        terminal_protocol::StreamPosition {
                                            epoch: stream_epoch,
                                            sequence: next_sequence,
                                        },
                                        bytes::Bytes::from(vec![u8::from(complete)]),
                                    )
                                    .and_then(|frame| codec.encode(frame));
                                    if let Ok(end) = end {
                                        frames.push(end.coalesce());
                                        if !outbound.enqueue_history(frames)
                                            && let Ok(error_end) = terminal_protocol::Frame::new(
                                                terminal_protocol::FrameType::ScrollbackEnd,
                                                0,
                                                stream_id,
                                                terminal_protocol::StreamPosition {
                                                    epoch: stream_epoch,
                                                    sequence: cursor,
                                                },
                                                bytes::Bytes::from_static(&[2]),
                                            )
                                            .and_then(|frame| codec.encode(frame))
                                        {
                                            let _ = outbound
                                                .enqueue_binary_reliable(error_end.coalesce());
                                        }
                                    }
                                });
                                continue;
                            }
                            terminal_protocol::FrameType::Resize if frame.payload.len() == 4 => {
                                let expected = control_position.saturating_add(1);
                                if frame.position.sequence != expected {
                                    outbound.close(1002, "terminal control sequence gap");
                                    break;
                                }
                                let cols = u16::from_be_bytes([frame.payload[0], frame.payload[1]]);
                                let rows = u16::from_be_bytes([frame.payload[2], frame.payload[3]]);
                                *control_position = expected;
                                runtime.terminal.authorize_and_resize(
                                    terminal_id,
                                    &principal.principal_id,
                                    &principal.connection_id,
                                    None,
                                    cols,
                                    rows,
                                )
                            }
                            _ => {
                                outbound.close(1002, "unsupported terminal binary frame");
                                break;
                            }
                        };
                        if let Err(error) = result {
                            let payload = serde_json::to_vec(&json!({
                                "type": "terminal:error",
                                "terminalId": terminal_id,
                                "code": error.wire_code(),
                                "message": error.to_string(),
                            }));
                            let Ok(payload) = payload else {
                                outbound.close(1011, "terminal error serialization failed");
                                break;
                            };
                            if !outbound.enqueue_protocol_frame(
                                terminal_protocol::FrameType::Error,
                                frame.stream_id,
                                frame.position.epoch,
                                frame.position.sequence,
                                bytes::Bytes::from(payload),
                            ) { break; }
                        }
                    }
                    Message::Close(_) => break,
                    _ => {}
                }
            }
            event = events.recv() => {
                let event = match event {
                    Ok(event) => event,
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        outbound.close(1013, "metadata outbound mailbox overflow");
                        break;
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                };
                match event.as_ref() {
                    HubMessage::Terminal(_) => continue,
                    HubMessage::Event(event) => {
                        if protocol == 2 && event.sequence <= snapshot_sequence {
                            continue;
                        }
                        if event.channel.as_ref() == "security:device-revoked" {
                            let revoked = event.args.first().and_then(Value::as_str);
                            if revoked == principal.device_id.as_deref() {
                                outbound.close(4003, "access revoked");
                                break;
                            }
                            continue;
                        }
                        if event.channel.as_ref() == "terminal:semantic" { continue; }
                        if protocol == 2 && event.channel.as_ref() == "terminal:exit" {
                            let Some(terminal_id) = event.args.first().and_then(Value::as_str) else {
                                continue;
                            };
                            let Some((stream_id, (_, epoch, _, _))) = terminal_streams
                                .iter()
                                .find(|(_, (id, _, _, _))| id == terminal_id)
                            else {
                                continue;
                            };
                            let sequence = runtime
                                .terminal
                                .inspect(terminal_id)
                                .map_or(0, |terminal| terminal.output_position);
                            let payload = serde_json::to_vec(event.args.as_ref())
                                .map(bytes::Bytes::from);
                            let Ok(payload) = payload else {
                                outbound.close(1011, "SESSION_EXIT serialization failed");
                                break;
                            };
                            if !outbound.enqueue_protocol_frame(
                                terminal_protocol::FrameType::SessionExit,
                                *stream_id,
                                *epoch,
                                sequence,
                                payload,
                            ) { break; }
                            continue;
                        }
                        let outgoing = if protocol == 1 { event.legacy() } else { (**event).clone() };
                        if !outbound.enqueue_reliable(&outgoing) { break; }
                    }
                }
            }
        }
    }
    runtime.events.detach_connection(&principal.connection_id);
    outbound.stop();
    let _ = writer.await;
    runtime
        .terminal
        .release_connection(&principal.connection_id);
}

fn handle_binary_attach(
    runtime: &HostRuntime,
    principal: &Principal,
    outbound: &ConnectionOutbound,
    terminal_subscriber: &Arc<dyn TerminalSubscriber>,
    attached: &mut HashSet<String>,
    raw: &mut HashSet<String>,
    terminal_streams: &mut HashMap<u64, (String, u64, u64, u64)>,
    frame: terminal_protocol::Frame,
) -> bool {
    if frame.stream_id != 0 || frame.position.epoch != 0 || frame.position.sequence == 0 {
        outbound.close(1002, "invalid ATTACH frame header");
        return false;
    }
    let Ok(command) = serde_json::from_slice::<TerminalWsCommand>(&frame.payload) else {
        outbound.close(1002, "invalid ATTACH payload");
        return false;
    };
    if command.request_id.is_empty() || command.op != "terminal:attach" {
        outbound.close(1002, "mismatched ATTACH operation");
        return false;
    }
    let Some(id) = command.args.first().and_then(Value::as_str) else {
        outbound.close(1002, "ATTACH terminal ID is required");
        return false;
    };
    let id = id.to_owned();
    let acknowledged = command.args.get(1).and_then(Value::as_u64).unwrap_or(0);
    let mode = command.args.get(2).and_then(Value::as_str).unwrap_or("raw");
    attached.insert(id.clone());
    if matches!(mode, "raw" | "both") {
        raw.insert(id.clone());
    }
    outbound.attach(&id, acknowledged);
    if raw.contains(&id) {
        runtime
            .events
            .attach_terminal(&id, &principal.connection_id, terminal_subscriber);
    }

    let mut snapshot_payload = None;
    let result = runtime
        .attach_terminal_binary(principal, &command.args)
        .and_then(|mut attach| {
            snapshot_payload = attach
                .checkpoint
                .as_mut()
                .map(|checkpoint| std::mem::take(&mut checkpoint.snapshot_bytes.0));
            let mut value = serde_json::to_value(attach)?;
            if let Some(object) = value.as_object_mut() {
                object.insert("ownerId".to_owned(), json!(runtime.identity.server_id));
                object.insert(
                    "ownerEpoch".to_owned(),
                    json!(runtime.identity.server_epoch),
                );
            }
            Ok(value)
        });

    let mut snapshot_sequence = None;
    let mut stream = None;
    let response = match result {
        Ok(value) => {
            let sequence = value
                .get("lastSequence")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            snapshot_sequence = Some(sequence);
            stream = value
                .get("streamId")
                .and_then(Value::as_u64)
                .zip(value.get("streamEpoch").and_then(Value::as_u64));
            if let Some((stream_id, epoch)) = stream {
                terminal_streams.insert(stream_id, (id.clone(), epoch, 0, 0));
            }
            json!({
                "type": "terminal:result",
                "requestId": command.request_id,
                "ok": true,
                "value": value,
            })
        }
        Err(error) => {
            attached.remove(&id);
            raw.remove(&id);
            outbound.detach(&id);
            runtime
                .events
                .detach_terminal(&id, &principal.connection_id);
            json!({
                "type": "terminal:result",
                "requestId": command.request_id,
                "ok": false,
                "error": { "code": error.wire_code(), "message": error.to_string() },
            })
        }
    };
    outbound.enqueue_attach_result(&id, snapshot_sequence, stream, snapshot_payload, &response)
}

async fn socket_writer(
    mut sender: SplitSink<WebSocket, Message>,
    outbound: Arc<ConnectionOutbound>,
) {
    while let Some(next) = outbound.next().await {
        match next {
            NextOutbound::Frame(frame) => {
                let message = match frame.kind {
                    OutboundFrameKind::Binary => Message::Binary(frame.data),
                    OutboundFrameKind::Text => {
                        let Ok(text) = String::from_utf8(frame.data.to_vec()) else {
                            let _ = close_socket(&mut sender, 1011, "invalid outbound text").await;
                            break;
                        };
                        Message::Text(text.into())
                    }
                };
                if sender.send(message).await.is_err() {
                    break;
                }
            }
            NextOutbound::Close { code, reason } => {
                let _ = close_socket(&mut sender, code, reason).await;
                break;
            }
        }
    }
    outbound.stop();
}

async fn authenticate_modern(
    runtime: &HostRuntime,
    sender: &mut SplitSink<WebSocket, Message>,
    receiver: &mut SplitStream<WebSocket>,
    connection_id: &str,
) -> Option<Principal> {
    if runtime.config.auth_token.is_none() {
        return Some(Principal::local(connection_id.to_owned()));
    }
    send_json(sender, &json!({ "type": "protocol:auth-required" }))
        .await
        .ok()?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let message = match tokio::time::timeout_at(deadline, receiver.next()).await {
            Ok(Some(Ok(message))) => message,
            Ok(Some(Err(_)) | None) => return None,
            Err(_) => {
                let _ = close_socket(sender, 4003, "authentication required").await;
                return None;
            }
        };
        let Message::Text(text) = message else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<Value>(text.as_str()) else {
            continue;
        };
        let Some(token) = value
            .as_object()
            .filter(|object| object.get("type").and_then(Value::as_str) == Some("protocol:auth"))
            .and_then(|object| object.get("token"))
            .and_then(Value::as_str)
        else {
            continue;
        };
        let principal = principal_for_token(runtime, Some(token), connection_id.to_owned());
        if principal.is_none() {
            let _ = close_socket(sender, 4003, "authentication failed").await;
        }
        return principal;
    }
}

fn request_principal(
    runtime: &HostRuntime,
    headers: &HeaderMap,
    uri: &Uri,
    correlation: Option<&str>,
) -> Option<Principal> {
    let token = bearer_token(headers).or_else(|| query_token(uri));
    let connection_id = correlation
        .filter(|value| !value.is_empty() && value.len() <= 256)
        .map_or_else(
            || format!("http-{}", Uuid::new_v4()),
            |value| format!("http-{value}"),
        );
    principal_for_token(runtime, token.as_deref(), connection_id)
}

fn principal_for_token(
    runtime: &HostRuntime,
    provided: Option<&str>,
    connection_id: String,
) -> Option<Principal> {
    if let (Some(expected), Some(provided)) = (runtime.config.auth_token.as_deref(), provided)
        && tokens_equal(expected, provided)
    {
        return Some(Principal::token(connection_id));
    }
    if let Some(token) = provided
        && let Ok(Some(session)) = runtime.devices.session(token)
    {
        return Some(Principal::paired(
            session.device_id,
            &session.scopes,
            connection_id,
        ));
    }
    if runtime.config.auth_token.is_none() && is_loopback_hostname(&runtime.config.host) {
        return Some(Principal::local(connection_id));
    }
    None
}

fn bearer_token(headers: &HeaderMap) -> Option<String> {
    if let Some(value) = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        && let Some(token) = value
            .strip_prefix("Bearer ")
            .or_else(|| value.strip_prefix("bearer "))
    {
        return Some(token.trim().to_owned());
    }
    headers
        .get("x-yaade-token")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn query_token(uri: &Uri) -> Option<String> {
    uri.query().and_then(|query| {
        url::form_urlencoded::parse(query.as_bytes())
            .find(|(key, _)| key == "token")
            .map(|(_, value)| value.into_owned())
    })
}

fn tokens_equal(expected: &str, provided: &str) -> bool {
    let expected = Sha256::digest(expected.as_bytes());
    let provided = Sha256::digest(provided.as_bytes());
    bool::from(expected.as_slice().ct_eq(provided.as_slice()))
}

fn is_desktop_origin(url: &url::Url) -> bool {
    (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost"))
}

fn is_local_browser_host(host: Option<&str>) -> bool {
    matches!(host, Some("localhost" | "127.0.0.1" | "::1" | "ide.local"))
}

fn allowed_cors_origin(origin: &str, allowed: &[String]) -> bool {
    let Ok(url) = url::Url::parse(origin) else {
        return false;
    };
    if is_desktop_origin(&url) {
        return true;
    }
    if !matches!(url.scheme(), "http" | "https") {
        return false;
    }
    is_local_browser_host(url.host_str())
        || allowed
            .iter()
            .any(|candidate| candidate == "*" || candidate == origin)
}

fn allowed_http_origin(origin: &str, bind_host: &str, allowed: &[String]) -> bool {
    if !allowed_cors_origin(origin, allowed) {
        return false;
    }
    if is_loopback_hostname(bind_host) {
        return true;
    }
    let Ok(url) = url::Url::parse(origin) else {
        return false;
    };
    is_desktop_origin(&url)
        || url.scheme() != "http"
        || url.host_str().is_some_and(is_loopback_hostname)
}

fn allowed_websocket_origin(
    origin: Option<&str>,
    request_host: Option<&str>,
    allowed: &[String],
) -> bool {
    let Some(origin) = origin else {
        return true;
    };
    let Ok(url) = url::Url::parse(origin) else {
        return false;
    };
    if is_desktop_origin(&url) {
        return true;
    }
    if url.scheme() != "http" && url.scheme() != "https" {
        return false;
    }
    if is_local_browser_host(url.host_str()) {
        return true;
    }
    allowed
        .iter()
        .any(|candidate| candidate == "*" || candidate == origin)
        || request_host.is_some_and(|host| url.authority() == host)
}

async fn fallback(
    State(state): State<AppState>,
    method: Method,
    uri: Uri,
    request: Request<Body>,
) -> Response {
    if is_namespaced_api(uri.path()) {
        let Some(principal) = request_principal(&state.runtime, request.headers(), &uri, None)
        else {
            return unauthorized();
        };
        if !principal.can_admin {
            return scope_denied("route requires admin capability");
        }
        return json_response(
            StatusCode::NOT_FOUND,
            json!({ "error": { "code": "NOT_FOUND", "message": format!("no route {}", uri.path()), "details": {} } }),
        );
    }
    if method == Method::GET {
        if let Some(root) = state.runtime.config.static_dir.as_deref()
            && let Some(response) = serve_static(root, uri.path(), request.headers()).await
        {
            return response;
        }
        #[cfg(feature = "embedded-web")]
        if let Some(response) = serve_embedded_static(uri.path(), request.headers()) {
            return response;
        }
    }
    json_response(
        StatusCode::NOT_FOUND,
        json!({ "error": { "code": "NOT_FOUND", "message": format!("no route {}", uri.path()), "details": {} } }),
    )
}

#[cfg(feature = "embedded-web")]
fn serve_embedded_static(pathname: &str, headers: &HeaderMap) -> Option<Response> {
    let relative = if pathname == "/" {
        "index.html"
    } else {
        pathname.trim_start_matches('/')
    };
    let path = EMBEDDED_WEB
        .get_file(relative)
        .map(|_| relative)
        .unwrap_or("index.html");
    let accept = headers
        .get(header::ACCEPT_ENCODING)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    let (served, encoding) = if accepts_encoding(accept, "br")
        && EMBEDDED_WEB.get_file(format!("{path}.br")).is_some()
    {
        (format!("{path}.br"), Some("br"))
    } else if accepts_encoding(accept, "gzip")
        && EMBEDDED_WEB.get_file(format!("{path}.gz")).is_some()
    {
        (format!("{path}.gz"), Some("gzip"))
    } else {
        (path.to_owned(), None)
    };
    let file = EMBEDDED_WEB.get_file(&served)?;
    let mut response = Response::new(Body::from(Bytes::from_static(file.contents())));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(mime_guess::from_path(path).first_or_octet_stream().as_ref()).ok()?,
    );
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(if path.starts_with("assets/") && hashed_asset_name(path) {
            "public, max-age=31536000, immutable"
        } else {
            "no-cache"
        }),
    );
    response
        .headers_mut()
        .insert(header::VARY, HeaderValue::from_static("Accept-Encoding"));
    if let Some(encoding) = encoding {
        response
            .headers_mut()
            .insert(header::CONTENT_ENCODING, HeaderValue::from_static(encoding));
    }
    Some(response)
}

async fn serve_static(root: &Path, pathname: &str, headers: &HeaderMap) -> Option<Response> {
    let relative = if pathname == "/" {
        "index.html"
    } else {
        pathname.trim_start_matches('/')
    };
    let canonical_root = root.canonicalize().ok()?;
    let candidate = canonical_root.join(relative);
    let mut path = candidate
        .canonicalize()
        .ok()
        .filter(|path| path.starts_with(&canonical_root));
    if path.as_ref().is_none_or(|path| !path.is_file()) {
        path = Some(canonical_root.join("index.html"));
    }
    let path = path?.canonicalize().ok()?;
    if !path.starts_with(&canonical_root) || !path.is_file() {
        return None;
    }
    let accept = headers
        .get(header::ACCEPT_ENCODING)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    let (served, encoding) =
        if accepts_encoding(accept, "br") && compressed_path(&path, "br").is_file() {
            (compressed_path(&path, "br"), Some("br"))
        } else if accepts_encoding(accept, "gzip") && compressed_path(&path, "gz").is_file() {
            (compressed_path(&path, "gz"), Some("gzip"))
        } else {
            (path.clone(), None)
        };
    let bytes = tokio::fs::read(&served).await.ok()?;
    let mut response = Response::new(Body::from(bytes));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(
            mime_guess::from_path(&path)
                .first_or_octet_stream()
                .as_ref(),
        )
        .ok()?,
    );
    let immutable = path
        .strip_prefix(&canonical_root)
        .ok()
        .and_then(|relative| relative.to_str())
        .is_some_and(|relative| relative.starts_with("assets/") && hashed_asset_name(relative));
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(if immutable {
            "public, max-age=31536000, immutable"
        } else {
            "no-cache"
        }),
    );
    response
        .headers_mut()
        .insert(header::VARY, HeaderValue::from_static("Accept-Encoding"));
    if let Some(encoding) = encoding {
        response
            .headers_mut()
            .insert(header::CONTENT_ENCODING, HeaderValue::from_static(encoding));
    }
    Some(response)
}

fn accepts_encoding(header: &str, encoding: &str) -> bool {
    let mut wildcard = None;
    for entry in header.split(',') {
        let mut parts = entry.trim().split(';');
        let Some(name) = parts.next().map(str::trim) else {
            continue;
        };
        let mut quality = 1.0_f32;
        for parameter in parts {
            if let Some(value) = parameter.trim().strip_prefix("q=")
                && let Ok(parsed) = value.parse::<f32>()
            {
                quality = parsed.clamp(0.0, 1.0);
            }
        }
        if name.eq_ignore_ascii_case(encoding) {
            return quality > 0.0;
        }
        if name == "*" {
            wildcard = Some(quality);
        }
    }
    wildcard.is_some_and(|quality| quality > 0.0)
}

fn hashed_asset_name(relative: &str) -> bool {
    let Some(stem) = Path::new(relative)
        .file_stem()
        .and_then(|value| value.to_str())
    else {
        return false;
    };
    stem.rsplit_once('-').is_some_and(|(_, hash)| {
        hash.len() >= 8
            && hash
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    })
}

fn compressed_path(path: &Path, suffix: &str) -> PathBuf {
    PathBuf::from(format!("{}.{}", path.display(), suffix))
}

fn runtime_error(error: RuntimeError) -> Response {
    let status = StatusCode::from_u16(error.http_status()).unwrap_or(StatusCode::BAD_REQUEST);
    json_response(
        status,
        json!({
            "error": {
                "code": error.wire_code(),
                "message": error.to_string(),
                "details": {},
            }
        }),
    )
}

fn device_error(error: DeviceAuthError, fallback: StatusCode, code: &'static str) -> Response {
    let (status, code) = match error {
        DeviceAuthError::RateLimited => (StatusCode::TOO_MANY_REQUESTS, "RATE_LIMITED"),
        _ => (fallback, code),
    };
    json_response(
        status,
        json!({ "error": { "code": code, "message": error.to_string(), "details": {} } }),
    )
}

fn scope_denied(message: &str) -> Response {
    json_response(
        StatusCode::FORBIDDEN,
        json!({ "error": { "code": "SCOPE_DENIED", "message": message, "details": {} } }),
    )
}

fn unauthorized() -> Response {
    json_response(
        StatusCode::UNAUTHORIZED,
        json!({ "error": { "code": "UNAUTHORIZED", "message": "host token required", "details": {} } }),
    )
}

fn json_response(status: StatusCode, value: Value) -> Response {
    (status, Json(value)).into_response()
}

async fn send_json<T: serde::Serialize>(
    sender: &mut SplitSink<WebSocket, Message>,
    value: &T,
) -> Result<(), axum::Error> {
    let encoded = serde_json::to_string(value).map_err(axum::Error::new)?;
    sender.send(Message::Text(encoded.into())).await
}

async fn send_terminal_frame<T: serde::Serialize>(
    sender: &mut SplitSink<WebSocket, Message>,
    kind: terminal_protocol::FrameType,
    stream_id: u64,
    epoch: u64,
    sequence: u64,
    value: &T,
) -> Result<(), axum::Error> {
    let payload = serde_json::to_vec(value).map_err(axum::Error::new)?;
    let frame = terminal_protocol::Frame::new(
        kind,
        0,
        stream_id,
        terminal_protocol::StreamPosition { epoch, sequence },
        bytes::Bytes::from(payload),
    )
    .and_then(|frame| terminal_protocol::Codec::default().encode(frame))
    .map(terminal_protocol::EncodedFrame::coalesce)
    .map_err(axum::Error::new)?;
    sender.send(Message::Binary(frame)).await
}

async fn close_socket(
    sender: &mut SplitSink<WebSocket, Message>,
    code: u16,
    reason: &'static str,
) -> Result<(), axum::Error> {
    sender
        .send(Message::Close(Some(axum::extract::ws::CloseFrame {
            code,
            reason: reason.into(),
        })))
        .await
}

fn is_realtime_op(operation: &str) -> bool {
    matches!(
        operation,
        "terminal:write"
            | "terminal:writeBinary"
            | "terminal:resize"
            | "terminal:ready"
            | "terminal:detach"
            | "terminal:attach"
    )
}

fn terminal_flow_limit() -> usize {
    std::env::var("YAADE_TERMINAL_UNACKNOWLEDGED_BYTES")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value >= 64 * 1024)
        .unwrap_or(8 * 1024 * 1024)
}

#[cfg(test)]
struct TerminalFlow {
    acknowledged: u64,
    outstanding: usize,
    frames: VecDeque<(u64, usize)>,
}

#[cfg(test)]
impl TerminalFlow {
    fn new(acknowledged: u64) -> Self {
        Self {
            acknowledged,
            outstanding: 0,
            frames: VecDeque::new(),
        }
    }

    fn reserve(&mut self, sequence: u64, bytes: usize, limit: usize) -> bool {
        if self.outstanding.saturating_add(bytes) > limit {
            return false;
        }
        self.outstanding += bytes;
        self.frames.push_back((sequence, bytes));
        true
    }

    fn acknowledge(&mut self, sequence: u64) {
        self.acknowledged = self.acknowledged.max(sequence);
        while self
            .frames
            .front()
            .is_some_and(|(frame, _)| *frame <= self.acknowledged)
        {
            if let Some((_, bytes)) = self.frames.pop_front() {
                self.outstanding = self.outstanding.saturating_sub(bytes);
            }
        }
    }
}

fn write_runtime_manifest(runtime: &HostRuntime, port: u16) -> std::io::Result<()> {
    let target = runtime.config.data_dir.join("runtime.json");
    let temporary = runtime
        .config
        .data_dir
        .join(format!("runtime.json.{}.tmp", std::process::id()));
    let body = serde_json::to_vec(&json!({
        "schemaVersion": 1,
        "serverId": runtime.identity.server_id,
        "serverEpoch": runtime.identity.server_epoch,
        "pid": std::process::id(),
        "processIdentity": capture_process_identity(std::process::id()),
        "host": "127.0.0.1",
        "port": port,
        "startedAt": runtime.identity.started_at,
    }))?;
    std::fs::write(&temporary, body)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o600))?;
    }
    std::fs::rename(temporary, target)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_surface_paths_are_not_classified_as_apis() {
        assert!(!is_namespaced_api("/agents"));
        assert!(!is_namespaced_api("/agents/new"));
        assert!(!is_namespaced_api("/tasks"));
        assert!(!is_namespaced_api("/tasks/projects/project-1"));
        assert!(!is_namespaced_api("/terminals"));
        assert!(is_namespaced_api("/agents/v1/runs"));
        assert!(is_namespaced_api("/tasks/api/tasks"));
        assert!(is_namespaced_api("/terminal/api/v1/sessions"));
    }

    #[test]
    fn token_comparison_requires_an_exact_value() {
        assert!(tokens_equal("secret", "secret"));
        assert!(!tokens_equal("secret", "secreT"));
        assert!(!tokens_equal("secret", "short"));
    }

    #[test]
    fn encoding_quality_zero_is_rejected() {
        assert!(!accepts_encoding("br;q=0, gzip;q=0.5", "br"));
        assert!(accepts_encoding("br;q=0, gzip;q=0.5", "gzip"));
        assert!(accepts_encoding("*;q=1", "br"));
    }

    #[test]
    fn desktop_and_loopback_origins_are_allowed() {
        assert!(allowed_cors_origin("tauri://localhost", &[]));
        assert!(allowed_cors_origin("http://127.0.0.1:4747", &[]));
        assert!(!allowed_cors_origin("file:///tmp/index.html", &[]));
    }

    #[test]
    fn websocket_origin_accepts_non_browser_and_exact_same_origin_clients() {
        assert!(allowed_websocket_origin(None, None, &[]));
        assert!(allowed_websocket_origin(
            Some("https://host.example:9443"),
            Some("host.example:9443"),
            &[],
        ));
        assert!(!allowed_websocket_origin(
            Some("https://attacker.example"),
            Some("host.example"),
            &[],
        ));
    }

    #[test]
    fn remote_bind_http_origins_require_desktop_loopback_or_https() {
        assert!(allowed_http_origin("tauri://localhost", "0.0.0.0", &[]));
        assert!(allowed_http_origin("http://127.0.0.1:3000", "0.0.0.0", &[]));
        assert!(allowed_http_origin(
            "https://client.example",
            "0.0.0.0",
            &["https://client.example".to_owned()],
        ));
        assert!(!allowed_http_origin(
            "http://client.example",
            "0.0.0.0",
            &["http://client.example".to_owned()],
        ));
    }

    #[test]
    fn acknowledgements_release_per_terminal_output_credit() {
        let mut flow = TerminalFlow::new(0);
        assert!(flow.reserve(1, 40, 64));
        assert!(!flow.reserve(2, 30, 64));
        flow.acknowledge(1);
        assert!(flow.reserve(2, 30, 64));
        assert_eq!(flow.acknowledged, 1);
    }

    #[test]
    fn lagging_terminals_have_independent_credit() {
        let mut first = TerminalFlow::new(0);
        let mut second = TerminalFlow::new(0);
        assert!(first.reserve(1, 64, 64));
        assert!(!first.reserve(2, 1, 64));
        assert!(second.reserve(1, 64, 64));
    }

    #[test]
    fn stale_acknowledgements_do_not_release_newer_frames() {
        let mut flow = TerminalFlow::new(4);
        assert!(flow.reserve(5, 32, 64));
        flow.acknowledge(4);
        assert_eq!(flow.outstanding, 32);
        assert!(!flow.reserve(6, 33, 64));
    }

    #[test]
    fn flow_can_resynchronize_from_a_known_acknowledged_sequence() {
        let mut flow = TerminalFlow::new(42);
        assert_eq!(flow.acknowledged, 42);
        assert!(flow.reserve(43, 64, 64));
        flow.acknowledge(43);
        assert_eq!(flow.outstanding, 0);
    }
}
