#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    io::{Read as _, Write as _},
    net::{Ipv4Addr, SocketAddr, SocketAddrV4, TcpStream},
    time::Duration,
};

use tauri::{Emitter as _, Manager as _};
use tauri_plugin_shell::ShellExt as _;

const DEFAULT_SERVER_ADDRESS: SocketAddr =
    SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 7774));
const DESKTOP_MENU_EVENT: &str = "yaade://menu-command";

fn menu_command(menu_id: &str) -> Option<&'static str> {
    match menu_id {
        "session.new" => Some("session.new"),
        "tab.new" => Some("tab.new"),
        "terminal.newTerminal" => Some("terminal.newTerminal"),
        "pane.splitRight" => Some("pane.splitRight"),
        "pane.splitDown" => Some("pane.splitDown"),
        "sidebar.toggle" => Some("sidebar.toggle"),
        "settings.show" => Some("settings.show"),
        _ => None,
    }
}

#[cfg(target_os = "macos")]
fn build_native_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{MenuBuilder, MenuItem, SubmenuBuilder};

    let settings = MenuItem::with_id(app, "settings.show", "Settings…", true, Some("CmdOrCtrl+,"))?;
    let new_session = MenuItem::with_id(
        app,
        "session.new",
        "New Session",
        true,
        Some("CmdOrCtrl+Shift+N"),
    )?;
    let new_window = MenuItem::with_id(app, "tab.new", "New Window", true, Some("CmdOrCtrl+T"))?;
    let new_terminal = MenuItem::with_id(
        app,
        "terminal.newTerminal",
        "New Terminal",
        true,
        Some("CmdOrCtrl+N"),
    )?;
    let split_right = MenuItem::with_id(
        app,
        "pane.splitRight",
        "Split Right",
        true,
        Some("CmdOrCtrl+D"),
    )?;
    let split_down = MenuItem::with_id(
        app,
        "pane.splitDown",
        "Split Down",
        true,
        Some("CmdOrCtrl+Shift+D"),
    )?;
    let toggle_sidebar = MenuItem::with_id(
        app,
        "sidebar.toggle",
        "Toggle Sidebar",
        true,
        Some("CmdOrCtrl+B"),
    )?;

    let app_menu = SubmenuBuilder::new(app, "YAADE")
        .about(None)
        .separator()
        .item(&settings)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;
    let file_menu = SubmenuBuilder::new(app, "File")
        .item(&new_session)
        .item(&new_window)
        .item(&new_terminal)
        .separator()
        .close_window()
        .build()?;
    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    let view_menu = SubmenuBuilder::new(app, "View")
        .item(&split_right)
        .item(&split_down)
        .separator()
        .item(&toggle_sidebar)
        .separator()
        .fullscreen()
        .build()?;
    let window_menu = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .separator()
        .bring_all_to_front()
        .build()?;

    MenuBuilder::new(app)
        .items(&[&app_menu, &file_menu, &edit_menu, &view_menu, &window_menu])
        .build()
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_shell::init())
        .on_menu_event(|app, event| {
            if let Some(command) = menu_command(&event.id().0) {
                let _ = app.emit_to("main", DESKTOP_MENU_EVENT, command);
            }
        })
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_menu(build_native_menu(app.handle())?)?;

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if default_server_is_running() {
                    return;
                }
                let command = match handle.shell().sidecar("yaade") {
                    Ok(command) => {
                        command.args(["install", "--host", "127.0.0.1", "--port", "7774"])
                    }
                    Err(error) => {
                        eprintln!("[yaade-desktop] could not locate server sidecar: {error}");
                        return;
                    }
                };
                match command.output().await {
                    Ok(output)
                        if output.status.success()
                            && String::from_utf8_lossy(&output.stdout)
                                .contains("\"running\":true") => {}
                    Ok(output) => eprintln!(
                        "[yaade-desktop] could not start server service: {} {}",
                        String::from_utf8_lossy(&output.stderr).trim(),
                        String::from_utf8_lossy(&output.stdout).trim()
                    ),
                    Err(error) => {
                        eprintln!("[yaade-desktop] could not start server service: {error}");
                    }
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("could not run YAADE desktop");
}

fn default_server_is_running() -> bool {
    let Ok(mut stream) =
        TcpStream::connect_timeout(&DEFAULT_SERVER_ADDRESS, Duration::from_millis(300))
    else {
        return false;
    };
    let timeout = Some(Duration::from_millis(500));
    if stream.set_read_timeout(timeout).is_err() || stream.set_write_timeout(timeout).is_err() {
        return false;
    }
    if stream
        .write_all(b"GET /terminal/health HTTP/1.1\r\nHost: 127.0.0.1:7774\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut response = String::new();
    stream.read_to_string(&mut response).is_ok() && response_is_healthy(&response)
}

fn response_is_healthy(response: &str) -> bool {
    response.starts_with("HTTP/1.1 200") && response.contains("\"status\":\"ok\"")
}

#[cfg(test)]
mod tests {
    use super::{menu_command, response_is_healthy};

    #[test]
    fn recognizes_native_menu_commands() {
        assert_eq!(menu_command("session.new"), Some("session.new"));
        assert_eq!(menu_command("pane.splitRight"), Some("pane.splitRight"));
        assert_eq!(menu_command("unknown"), None);
    }

    #[test]
    fn recognizes_only_successful_yaade_health_responses() {
        assert!(response_is_healthy(
            "HTTP/1.1 200 OK\r\n\r\n{\"status\":\"ok\"}"
        ));
        assert!(!response_is_healthy("HTTP/1.1 200 OK\r\n\r\nready"));
        assert!(!response_is_healthy(
            "HTTP/1.1 503 Service Unavailable\r\n\r\n{\"status\":\"ok\"}"
        ));
    }
}
