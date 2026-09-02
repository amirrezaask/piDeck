use std::{
    ffi::OsString,
    io::{Read as _, Write as _},
    net::TcpStream,
    path::PathBuf,
};

use serde_json::{Value, json};
use yaade_server::{
    config::HostConfig,
    server::serve,
    service::{
        ServiceAction, UserServiceOptions, control_user_service, install_user_service,
        uninstall_user_service,
    },
};

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("[yaade] {error}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args_os().skip(1).collect::<Vec<OsString>>();
    let command = args.first().and_then(|argument| argument.to_str());
    if matches!(command, Some("serve" | "run")) {
        args.remove(0);
        return run_server(args).await;
    }
    if matches!(
        command,
        Some("install" | "uninstall" | "start" | "stop" | "restart")
    ) {
        let command = args.remove(0).to_string_lossy().into_owned();
        let service_name = take_option(&mut args, "--service-name")?;
        let service_args = args.clone();
        let config = HostConfig::load(args)?;
        let executable = match std::env::var_os("YAADE_SERVER_EXECUTABLE") {
            Some(executable) => PathBuf::from(executable),
            None if command == "install" => install_executable(&config.data_dir)?,
            None => std::env::current_exe()?,
        };
        let mut options = UserServiceOptions::new(executable, config.data_dir);
        options.args = std::iter::once("serve".to_owned())
            .chain(
                service_args
                    .into_iter()
                    .map(|argument| argument.to_string_lossy().into_owned()),
            )
            .collect();
        if let Some(service_name) = service_name {
            options.service_name = service_name;
        }
        let status = match command.as_str() {
            "install" => install_user_service(&options)?,
            "uninstall" => uninstall_user_service(&options),
            "start" => control_user_service(ServiceAction::Start, &options),
            "stop" => control_user_service(ServiceAction::Stop, &options),
            "restart" => control_user_service(ServiceAction::Restart, &options),
            _ => unreachable!(),
        };
        println!("{}", serde_json::to_string(&status)?);
        return Ok(());
    }
    if matches!(command, Some("status" | "doctor" | "pair")) {
        let command = args.remove(0).to_string_lossy().into_owned();
        return inspect_runtime(&command, args);
    }
    run_server(args).await
}

fn install_executable(data_dir: &std::path::Path) -> std::io::Result<PathBuf> {
    let source = std::env::current_exe()?;
    let install_dir = data_dir.join("bin");
    std::fs::create_dir_all(&install_dir)?;
    let destination = install_dir.join(if cfg!(windows) {
        "yaade-server.exe"
    } else {
        "yaade-server"
    });
    if source != destination {
        std::fs::copy(source, &destination)?;
    }
    Ok(destination)
}

async fn run_server(args: Vec<OsString>) -> Result<(), Box<dyn std::error::Error>> {
    let config = HostConfig::load(args)?;
    serve(config).await?.wait().await;
    Ok(())
}

fn take_option(
    args: &mut Vec<OsString>,
    name: &str,
) -> Result<Option<String>, Box<dyn std::error::Error>> {
    let Some(index) = args.iter().position(|argument| argument == name) else {
        return Ok(None);
    };
    args.remove(index);
    if index == args.len() {
        return Err(format!("{name} requires a value").into());
    }
    Ok(Some(args.remove(index).to_string_lossy().into_owned()))
}

fn inspect_runtime(action: &str, args: Vec<OsString>) -> Result<(), Box<dyn std::error::Error>> {
    let config = HostConfig::load(args)?;
    let manifest_path = config.data_dir.join("runtime.json");
    let manifest = std::fs::read(&manifest_path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
    let storage_failure = std::fs::read(config.data_dir.join("storage-failure.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
    let host = manifest
        .as_ref()
        .and_then(|value| value.get("host"))
        .and_then(Value::as_str)
        .unwrap_or(&config.host);
    let port = manifest
        .as_ref()
        .and_then(|value| value.get("port"))
        .and_then(Value::as_u64)
        .and_then(|port| u16::try_from(port).ok())
        .unwrap_or(config.port);
    if action == "pair" {
        let token = config
            .auth_token
            .as_deref()
            .ok_or("pairing-code requires the configured host token")?;
        let (_, body) = http_request(
            host,
            port,
            "POST",
            "/terminal/api/v1/security/pairing-code",
            Some(token),
        )?;
        println!("{body}");
        return Ok(());
    }
    let (health_status, health_body) = if port == 0 {
        (0, "runtime manifest is missing".to_owned())
    } else {
        http_request(host, port, "GET", "/terminal/health", None)
            .unwrap_or_else(|error| (0, error.to_string()))
    };
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "action": action,
            "dataDir": config.data_dir,
            "manifest": manifest,
            "health": { "status": health_status, "body": health_body },
            "storageFailure": storage_failure,
        }))?
    );
    if action == "doctor" && (health_status != 200 || storage_failure.is_some()) {
        return Err("runtime health check failed".into());
    }
    Ok(())
}

fn http_request(
    host: &str,
    port: u16,
    method: &str,
    path: &str,
    token: Option<&str>,
) -> Result<(u16, String), Box<dyn std::error::Error>> {
    let connect_host = if host == "localhost" || host == "0.0.0.0" || host == "::" {
        "127.0.0.1"
    } else {
        host.trim_matches(['[', ']'])
    };
    let mut stream = TcpStream::connect((connect_host, port))?;
    stream.set_read_timeout(Some(std::time::Duration::from_secs(5)))?;
    let authorization = token.map_or_else(String::new, |token| {
        format!("Authorization: Bearer {token}\r\n")
    });
    write!(
        stream,
        "{method} {path} HTTP/1.1\r\nHost: {host}:{port}\r\n{authorization}Content-Length: 0\r\nConnection: close\r\n\r\n"
    )?;
    let mut response = String::new();
    stream.read_to_string(&mut response)?;
    let (headers, body) = response.split_once("\r\n\r\n").unwrap_or((&response, ""));
    let status = headers
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|value| value.parse().ok())
        .unwrap_or(0);
    Ok((status, body.to_owned()))
}
