use std::{
    collections::BTreeMap,
    path::PathBuf,
    process::{Command, Stdio},
};

use serde::Serialize;

const DEFAULT_SERVICE_NAME: &str = "com.yaade.server";

#[derive(Clone, Debug)]
pub struct UserServiceOptions {
    pub executable: PathBuf,
    pub data_dir: PathBuf,
    pub service_name: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
}

impl UserServiceOptions {
    #[must_use]
    pub fn new(executable: PathBuf, data_dir: PathBuf) -> Self {
        Self {
            executable,
            args: vec![
                "run".to_owned(),
                "--data-dir".to_owned(),
                data_dir.display().to_string(),
            ],
            data_dir,
            service_name: DEFAULT_SERVICE_NAME.to_owned(),
            env: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserServiceStatus {
    pub platform: &'static str,
    pub installed: bool,
    pub running: bool,
    pub path: String,
    pub message: String,
}

#[derive(Clone, Copy)]
pub enum ServiceAction {
    Start,
    Stop,
    Restart,
}

#[must_use]
pub fn user_service_path(options: &UserServiceOptions) -> PathBuf {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_default();
    if cfg!(target_os = "linux") {
        home.join(".config/systemd/user")
            .join(format!("{}.service", options.service_name))
    } else if cfg!(target_os = "macos") {
        home.join("Library/LaunchAgents")
            .join(format!("{}.plist", options.service_name))
    } else {
        home.join("AppData/Local/YAADE")
            .join(format!("{}.xml", options.service_name))
    }
}

#[must_use]
pub fn render_user_service(options: &UserServiceOptions) -> String {
    if cfg!(target_os = "linux") {
        let command = std::iter::once(options.executable.display().to_string())
            .chain(options.args.iter().cloned())
            .map(|value| shell_quote(&value))
            .collect::<Vec<_>>()
            .join(" ");
        let environment = options
            .env
            .iter()
            .map(|(key, value)| format!("Environment={key}={}", shell_quote(value)))
            .collect::<Vec<_>>()
            .join("\n");
        return format!(
            "[Unit]\nDescription=YAADE host service\nAfter=default.target\n\n[Service]\nExecStart={command}\nRestart=on-failure\nRestartSec=2\n{}\n[Install]\nWantedBy=default.target\n",
            if environment.is_empty() {
                String::new()
            } else {
                format!("{environment}\n")
            },
        );
    }
    if cfg!(target_os = "macos") {
        let arguments = std::iter::once(options.executable.display().to_string())
            .chain(options.args.iter().cloned())
            .map(|value| format!("    <string>{}</string>", escape_xml(&value)))
            .collect::<Vec<_>>()
            .join("\n");
        let environment = if options.env.is_empty() {
            String::new()
        } else {
            format!(
                "  <key>EnvironmentVariables</key><dict>\n{}\n  </dict>\n",
                options
                    .env
                    .iter()
                    .map(|(key, value)| format!(
                        "    <key>{}</key><string>{}</string>",
                        escape_xml(key),
                        escape_xml(value)
                    ))
                    .collect::<Vec<_>>()
                    .join("\n")
            )
        };
        return format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\"><dict>\n  <key>Label</key><string>{}</string>\n  <key>ProgramArguments</key><array>\n{arguments}\n  </array>\n  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><true/>\n  <key>WorkingDirectory</key><string>{}</string>\n{environment}</dict></plist>\n",
            escape_xml(&options.service_name),
            escape_xml(&options.data_dir.display().to_string())
        );
    }
    let arguments = options
        .args
        .iter()
        .map(|value| escape_xml(value))
        .collect::<Vec<_>>()
        .join(" ");
    format!(
        "<Task version=\"1.4\"><RegistrationInfo><Description>YAADE host service</Description></RegistrationInfo><Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers><Principals><Principal id=\"Author\"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><RestartOnFailure><Interval>PT2M</Interval><Count>3</Count></RestartOnFailure></Settings><Actions Context=\"Author\"><Exec><Command>{}</Command><Arguments>{arguments}</Arguments><WorkingDirectory>{}</WorkingDirectory></Exec></Actions></Task>",
        escape_xml(&options.executable.display().to_string()),
        escape_xml(&options.data_dir.display().to_string())
    )
}

pub fn install_user_service(options: &UserServiceOptions) -> std::io::Result<UserServiceStatus> {
    let target = user_service_path(options);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&target, render_user_service(options))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o600))?;
    }
    if cfg!(target_os = "linux") {
        let _ = run("systemctl", &["--user", "daemon-reload"]);
    } else if cfg!(target_os = "macos") {
        let domain = launchd_domain();
        let _ = run(
            "launchctl",
            &["bootout", &format!("{domain}/{}", options.service_name)],
        );
    }
    let running = if cfg!(target_os = "linux") {
        run(
            "systemctl",
            &["--user", "enable", "--now", &options.service_name],
        )
    } else if cfg!(target_os = "macos") {
        run(
            "launchctl",
            &[
                "bootstrap",
                &launchd_domain(),
                &target.display().to_string(),
            ],
        )
    } else {
        run(
            "schtasks.exe",
            &[
                "/Create",
                "/F",
                "/TN",
                &options.service_name,
                "/XML",
                &target.display().to_string(),
            ],
        ) && run("schtasks.exe", &["/Run", "/TN", &options.service_name])
    };
    Ok(status(
        options,
        true,
        running,
        if running {
            "service installed and running"
        } else {
            "service installed; start it with the platform service manager"
        },
    ))
}

pub fn control_user_service(
    action: ServiceAction,
    options: &UserServiceOptions,
) -> UserServiceStatus {
    let action_name = match action {
        ServiceAction::Start => "start",
        ServiceAction::Stop => "stop",
        ServiceAction::Restart => "restart",
    };
    let running = if cfg!(target_os = "linux") {
        run("systemctl", &["--user", action_name, &options.service_name])
    } else if cfg!(target_os = "macos") {
        let domain = launchd_domain();
        if !matches!(action, ServiceAction::Start) {
            let stopped = run(
                "launchctl",
                &["bootout", &format!("{domain}/{}", options.service_name)],
            );
            if matches!(action, ServiceAction::Stop) {
                return status(
                    options,
                    user_service_path(options).exists(),
                    stopped,
                    if stopped {
                        "service stop requested"
                    } else {
                        "could not stop service"
                    },
                );
            }
        }
        run(
            "launchctl",
            &[
                "bootstrap",
                &domain,
                &user_service_path(options).display().to_string(),
            ],
        )
    } else {
        run(
            "schtasks.exe",
            &[
                if matches!(action, ServiceAction::Stop) {
                    "/End"
                } else {
                    "/Run"
                },
                "/TN",
                &options.service_name,
            ],
        )
    };
    let message = if running {
        format!("service {action_name} requested")
    } else {
        format!("could not {action_name} service")
    };
    status(
        options,
        user_service_path(options).exists(),
        running,
        &message,
    )
}

#[must_use]
pub fn status_user_service(options: &UserServiceOptions) -> UserServiceStatus {
    let installed = user_service_path(options).exists();
    let running = if cfg!(target_os = "linux") {
        run("systemctl", &["--user", "is-active", &options.service_name])
    } else if cfg!(target_os = "macos") {
        run(
            "launchctl",
            &[
                "print",
                &format!("{}/{}", launchd_domain(), options.service_name),
            ],
        )
    } else {
        run("schtasks.exe", &["/Query", "/TN", &options.service_name])
    };
    status(
        options,
        installed,
        running,
        if !installed {
            "service is not installed"
        } else if running {
            "service is running"
        } else {
            "service is installed but not running"
        },
    )
}

pub fn uninstall_user_service(options: &UserServiceOptions) -> UserServiceStatus {
    if cfg!(target_os = "linux") {
        let _ = run(
            "systemctl",
            &["--user", "disable", "--now", &options.service_name],
        );
    } else if cfg!(target_os = "macos") {
        let _ = run(
            "launchctl",
            &[
                "bootout",
                &format!("{}/{}", launchd_domain(), options.service_name),
            ],
        );
    } else {
        let _ = run(
            "schtasks.exe",
            &["/Delete", "/F", "/TN", &options.service_name],
        );
    }
    let _ = std::fs::remove_file(user_service_path(options));
    status(options, false, false, "service removed")
}

fn status(
    options: &UserServiceOptions,
    installed: bool,
    running: bool,
    message: &str,
) -> UserServiceStatus {
    UserServiceStatus {
        platform: platform(),
        installed,
        running,
        path: user_service_path(options).display().to_string(),
        message: message.to_owned(),
    }
}
fn run(command: &str, args: &[&str]) -> bool {
    Command::new(command)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}
fn launchd_domain() -> String {
    format!(
        "gui/{}",
        command_text("id", &["-u"]).unwrap_or_else(|| "0".to_owned())
    )
}
fn command_text(command: &str, args: &[&str]) -> Option<String> {
    let output = Command::new(command).args(args).output().ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
}
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
fn escape_xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('\'', "&apos;")
        .replace('"', "&quot;")
}
const fn platform() -> &'static str {
    if cfg!(target_os = "windows") {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rendered_service_contains_executable_and_data_dir() {
        let options = UserServiceOptions::new(
            PathBuf::from("/opt/yaade"),
            PathBuf::from("/tmp/yaade data"),
        );
        let rendered = render_user_service(&options);
        assert!(rendered.contains("yaade"));
        assert!(rendered.contains("yaade data"));
        assert!(rendered.contains("run"));
    }
}
