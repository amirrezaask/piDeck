use std::{
    collections::BTreeMap,
    env,
    ffi::OsString,
    fs,
    path::{Component, Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use thiserror::Error;

const WORKSPACE_MARKERS: &[&str] = &[
    ".git",
    "package.json",
    "tsconfig.json",
    "Cargo.toml",
    "go.mod",
    ".yaade",
];

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchConfig {
    pub workspace_path: PathBuf,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_path: Option<PathBuf>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<LaunchSource>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LaunchSource {
    Default,
    Explicit,
    External,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostFeatures {
    pub terminal_checkpoints: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostConfig {
    pub host: String,
    pub port: u16,
    pub data_dir: PathBuf,
    pub allowed_roots: Vec<PathBuf>,
    pub open_browser: bool,
    pub launch_path: PathBuf,
    pub launch_config: LaunchConfig,
    pub static_dir: Option<PathBuf>,
    pub auth_token: Option<String>,
    pub cors_origins: Vec<String>,
    pub features: HostFeatures,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ConfigError {
    #[error(
        "binding to {host} requires --token or YAADE_HOST_TOKEN so the host API is not open on the network"
    )]
    PublicBindWithoutToken { host: String },
    #[error("invalid port: {0}")]
    InvalidPort(String),
    #[error("could not determine the current directory: {0}")]
    CurrentDirectory(String),
    #[error("could not determine the home directory")]
    HomeDirectory,
    #[error("could not create data directory {path}: {message}")]
    DataDirectory { path: PathBuf, message: String },
}

#[derive(Default)]
struct ParsedArgs {
    values: BTreeMap<String, String>,
    flags: BTreeMap<String, bool>,
    path: Option<String>,
}

impl HostConfig {
    pub fn load(args: impl IntoIterator<Item = OsString>) -> Result<Self, ConfigError> {
        let cwd =
            env::current_dir().map_err(|error| ConfigError::CurrentDirectory(error.to_string()))?;
        let environment = env::vars().collect::<BTreeMap<_, _>>();
        let home = home_dir(&environment).ok_or(ConfigError::HomeDirectory)?;
        Self::from_parts(args, &environment, &cwd, &home, None)
    }

    fn from_parts(
        args: impl IntoIterator<Item = OsString>,
        environment: &BTreeMap<String, String>,
        cwd: &Path,
        home: &Path,
        default_static_dir: Option<&Path>,
    ) -> Result<Self, ConfigError> {
        let args = parse_args(args);
        let host = arg_or_env(&args, "host", environment, "YAADE_HOST")
            .unwrap_or_else(|| "127.0.0.1".to_owned());
        let auth_token = arg_or_env(&args, "token", environment, "YAADE_HOST_TOKEN")
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty());
        if !is_loopback_hostname(&host) && auth_token.is_none() {
            return Err(ConfigError::PublicBindWithoutToken { host });
        }

        let port_text = arg_or_env(&args, "port", environment, "YAADE_PORT")
            .unwrap_or_else(|| "7774".to_owned());
        let port = port_text
            .parse::<u16>()
            .map_err(|_| ConfigError::InvalidPort(port_text.clone()))?;

        let data_dir = absolute_path(
            arg_or_env(&args, "data-dir", environment, "YAADE_DATA_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".local/share/yaade")),
            cwd,
        );
        fs::create_dir_all(&data_dir).map_err(|error| ConfigError::DataDirectory {
            path: data_dir.clone(),
            message: error.to_string(),
        })?;

        let mut allowed_roots = split_list(args.values.get("allowed-roots"))
            .chain(split_list(environment.get("YAADE_ALLOWED_ROOTS")))
            .map(|root| absolute_path(PathBuf::from(root), cwd))
            .collect::<Vec<_>>();
        if allowed_roots.is_empty() {
            allowed_roots.push(absolute_path(home.to_owned(), cwd));
        }
        allowed_roots.sort();
        allowed_roots.dedup();

        let home_root = absolute_path(home.to_owned(), cwd);
        let cwd = absolute_path(cwd.to_owned(), cwd);
        let default_workspace = if path_allowed(&cwd, &allowed_roots) {
            cwd.clone()
        } else {
            home_root.clone()
        };
        let explicit_path = args
            .path
            .as_deref()
            .map(PathBuf::from)
            .map(|path| absolute_path(path, &cwd));
        let mut launch_config = resolve_launch_target(
            explicit_path.as_deref(),
            &cwd,
            explicit_path
                .as_ref()
                .map_or(Some(default_workspace.as_path()), |_| None),
        );
        if !path_allowed(&launch_config.workspace_path, &allowed_roots) {
            if explicit_path.is_some() {
                allowed_roots.push(launch_config.workspace_path.clone());
                allowed_roots.sort();
                allowed_roots.dedup();
            } else {
                launch_config = LaunchConfig {
                    workspace_path: home_root.clone(),
                    file_path: None,
                    source: Some(LaunchSource::Default),
                };
            }
        }
        let launch_path = explicit_path.unwrap_or(default_workspace);

        let static_dir = arg_or_env(&args, "static-dir", environment, "YAADE_STATIC_DIR")
            .map(PathBuf::from)
            .or_else(|| default_static_dir.map(Path::to_owned))
            .map(|path| absolute_path(path, &cwd))
            .filter(|path| path.exists());

        let cors_origins = arg_or_env(&args, "cors-origins", environment, "YAADE_CORS_ORIGINS")
            .as_ref()
            .map(|value| {
                value
                    .split(',')
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default();
        let terminal_checkpoints = args
            .values
            .get("terminal-checkpoints")
            .and_then(|value| parse_on_off(value))
            .or_else(|| args.flags.get("terminal-checkpoints").copied())
            .or_else(|| {
                environment
                    .get("YAADE_TERMINAL_CHECKPOINTS")
                    .and_then(|value| parse_on_off(value))
            })
            .unwrap_or(true);

        Ok(Self {
            host,
            port,
            data_dir,
            allowed_roots,
            open_browser: args.flags.get("open").copied().unwrap_or(false)
                || environment
                    .get("YAADE_OPEN_BROWSER")
                    .is_some_and(|value| value == "1"),
            launch_path,
            launch_config,
            static_dir,
            auth_token,
            cors_origins,
            features: HostFeatures {
                terminal_checkpoints,
            },
        })
    }
}

fn parse_args(args: impl IntoIterator<Item = OsString>) -> ParsedArgs {
    let mut parsed = ParsedArgs::default();
    let mut args = args
        .into_iter()
        .map(|value| value.to_string_lossy().into_owned())
        .peekable();
    while let Some(argument) = args.next() {
        if argument == "--open" || argument == "-o" {
            parsed.flags.insert("open".to_owned(), true);
            continue;
        }
        if let Some(key) = argument.strip_prefix("--") {
            if args.peek().is_some_and(|next| !next.starts_with("--")) {
                if let Some(value) = args.next() {
                    parsed.values.insert(key.to_owned(), value);
                }
            } else {
                parsed.flags.insert(key.to_owned(), true);
            }
            continue;
        }
        if parsed.path.is_none() {
            parsed.path = Some(argument);
        }
    }
    parsed
}

fn arg_or_env(
    args: &ParsedArgs,
    argument: &str,
    environment: &BTreeMap<String, String>,
    variable: &str,
) -> Option<String> {
    args.values
        .get(argument)
        .cloned()
        .or_else(|| environment.get(variable).cloned())
}

fn split_list(value: Option<&String>) -> impl Iterator<Item = &str> {
    value
        .into_iter()
        .flat_map(|value| value.split(','))
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn parse_on_off(value: &str) -> Option<bool> {
    match value {
        "1" | "true" => Some(true),
        "0" | "false" => Some(false),
        _ => None,
    }
}

pub fn is_loopback_hostname(hostname: &str) -> bool {
    let normalized = hostname.trim().trim_matches(['[', ']']);
    normalized.eq_ignore_ascii_case("localhost") || normalized == "127.0.0.1" || normalized == "::1"
}

pub fn path_allowed(candidate: &Path, roots: &[PathBuf]) -> bool {
    let candidate = canonical_existing_ancestor(candidate);
    roots.iter().any(|root| {
        let root = root
            .canonicalize()
            .unwrap_or_else(|_| absolute_path(root.to_owned(), Path::new("/")));
        candidate == root || candidate.starts_with(&root)
    })
}

fn canonical_existing_ancestor(path: &Path) -> PathBuf {
    let mut current = absolute_path(path.to_owned(), Path::new("/"));
    loop {
        if let Ok(canonical) = current.canonicalize() {
            return canonical;
        }
        if !current.pop() {
            return absolute_path(path.to_owned(), Path::new("/"));
        }
    }
}

fn home_dir(environment: &BTreeMap<String, String>) -> Option<PathBuf> {
    environment
        .get("HOME")
        .or_else(|| environment.get("USERPROFILE"))
        .map(PathBuf::from)
}

fn absolute_path(path: PathBuf, cwd: &Path) -> PathBuf {
    let absolute = if path.is_absolute() {
        path
    } else {
        cwd.join(path)
    };
    let mut normalized = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized
}

fn resolve_launch_target(
    explicit_path: Option<&Path>,
    cwd: &Path,
    default_cwd: Option<&Path>,
) -> LaunchConfig {
    let fallback = default_cwd.unwrap_or(cwd);
    let Some(target) = explicit_path else {
        return LaunchConfig {
            workspace_path: fallback.to_owned(),
            file_path: None,
            source: Some(LaunchSource::Default),
        };
    };
    match fs::metadata(target) {
        Ok(metadata) if metadata.is_dir() => LaunchConfig {
            workspace_path: target.to_owned(),
            file_path: None,
            source: Some(LaunchSource::Explicit),
        },
        Ok(_) => LaunchConfig {
            workspace_path: find_workspace_root(target.parent().unwrap_or(cwd)),
            file_path: Some(target.to_owned()),
            source: Some(LaunchSource::Explicit),
        },
        Err(_) => LaunchConfig {
            workspace_path: fallback.to_owned(),
            file_path: None,
            source: Some(LaunchSource::Default),
        },
    }
}

fn find_workspace_root(start: &Path) -> PathBuf {
    let mut current = start.to_owned();
    for _ in 0..20 {
        if WORKSPACE_MARKERS
            .iter()
            .any(|marker| current.join(marker).exists())
        {
            return current;
        }
        if !current.pop() {
            break;
        }
    }
    start.to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root() -> PathBuf {
        let root = env::temp_dir().join(format!("yaade-rust-config-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).expect("create test root");
        root
    }

    #[test]
    fn defaults_to_loopback_and_home_root() {
        let root = temp_root();
        let home = root.join("home");
        fs::create_dir_all(&home).expect("create home");
        let environment = BTreeMap::from([("HOME".to_owned(), home.display().to_string())]);
        let config = HostConfig::from_parts([], &environment, &root, &home, None).expect("config");

        assert_eq!(config.host, "127.0.0.1");
        assert_eq!(config.port, 7774);
        assert_eq!(config.allowed_roots, vec![home.clone()]);
        assert_eq!(config.launch_path, home);
        assert!(config.features.terminal_checkpoints);
    }

    #[test]
    fn accepts_public_bind_with_host_token() {
        let root = temp_root();
        let environment = BTreeMap::from([("HOME".to_owned(), root.display().to_string())]);
        let config = HostConfig::from_parts(
            [
                OsString::from("--host"),
                OsString::from("0.0.0.0"),
                OsString::from("--token"),
                OsString::from("secret"),
            ],
            &environment,
            &root,
            &root,
            None,
        )
        .expect("public config");
        assert_eq!(config.host, "0.0.0.0");
        assert_eq!(config.auth_token.as_deref(), Some("secret"));
    }

    #[test]
    fn rejects_public_bind_without_token() {
        let root = temp_root();
        let environment = BTreeMap::from([("HOME".to_owned(), root.display().to_string())]);
        let error = HostConfig::from_parts(
            [OsString::from("--host"), OsString::from("0.0.0.0")],
            &environment,
            &root,
            &root,
            None,
        )
        .expect_err("public bind must fail");

        assert_eq!(
            error,
            ConfigError::PublicBindWithoutToken {
                host: "0.0.0.0".to_owned(),
            }
        );
    }

    #[test]
    fn explicit_workspace_outside_home_becomes_allowed() {
        let root = temp_root();
        let home = root.join("home");
        let workspace = root.join("external/workspace");
        fs::create_dir_all(&home).expect("create home");
        fs::create_dir_all(&workspace).expect("create workspace");
        let environment = BTreeMap::from([("HOME".to_owned(), home.display().to_string())]);
        let config = HostConfig::from_parts(
            [workspace.clone().into_os_string()],
            &environment,
            &home,
            &home,
            None,
        )
        .expect("config");

        assert_eq!(config.launch_config.workspace_path, workspace);
        assert!(config.allowed_roots.contains(&workspace));
    }

    #[test]
    fn cwd_under_home_is_the_default_workspace() {
        let root = temp_root();
        let home = root.join("home");
        let cwd = home.join("project");
        fs::create_dir_all(&cwd).expect("cwd");
        let environment = BTreeMap::from([("HOME".to_owned(), home.display().to_string())]);
        let config = HostConfig::from_parts([], &environment, &cwd, &home, None).expect("config");
        assert_eq!(config.launch_path, cwd);
    }

    #[test]
    fn cwd_outside_allowed_roots_falls_back_to_home() {
        let root = temp_root();
        let home = root.join("home");
        let cwd = root.join("outside");
        fs::create_dir_all(&home).expect("home");
        fs::create_dir_all(&cwd).expect("cwd");
        let environment = BTreeMap::from([("HOME".to_owned(), home.display().to_string())]);
        let config = HostConfig::from_parts([], &environment, &cwd, &home, None).expect("config");
        assert_eq!(config.launch_path, home);
    }

    #[test]
    fn terminal_checkpoints_can_be_disabled() {
        let root = temp_root();
        let environment = BTreeMap::from([
            ("HOME".to_owned(), root.display().to_string()),
            ("YAADE_TERMINAL_CHECKPOINTS".to_owned(), "0".to_owned()),
        ]);
        let config = HostConfig::from_parts([], &environment, &root, &root, None).expect("config");
        assert!(!config.features.terminal_checkpoints);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_symlink_that_escapes_an_allowed_root() {
        use std::os::unix::fs::symlink;

        let root = temp_root();
        let allowed = root.join("allowed");
        let outside = root.join("outside");
        fs::create_dir_all(&allowed).expect("allowed root");
        fs::create_dir_all(&outside).expect("outside root");
        symlink(&outside, allowed.join("escape")).expect("symlink");

        assert!(!path_allowed(&allowed.join("escape/file.txt"), &[allowed]));
    }

    #[test]
    fn recognizes_ip_loopback_forms() {
        assert!(is_loopback_hostname("localhost"));
        assert!(is_loopback_hostname("[::1]"));
        assert!(!is_loopback_hostname("127.0.0.2"));
        assert!(!is_loopback_hostname("0.0.0.0"));
    }
}
