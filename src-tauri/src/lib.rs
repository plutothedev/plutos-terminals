// Pluto's Terminal — Tauri app entry.
//
// Lifted from Lyfe's lib.rs with KB/journal init removed and rebranded.
// Closing the window hides to the system tray so PTY sessions keep running
// in the background. Only an explicit "Quit" from the tray menu fires
// RunEvent::ExitRequested → kill_all() so no shell children orphan.

mod coalesce;
mod commands;
mod companion;
mod forward;
mod llm;
mod llm_tools;
mod netools;
mod pty;
mod rdp;
mod session;
mod sftp;
mod share;
mod sshconfig;
mod sysstats;
pub mod mcp;
mod sync_git;
mod vault;
mod vncclient;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::Manager;

const DEFAULT_SUMMON: &str = "Ctrl+Shift+Backquote";

// Map a W3C KeyboardEvent.code token to a global-shortcut Code. Covers the keys
// a user might realistically bind the summon hotkey to.
fn summon_code(token: &str) -> Option<tauri_plugin_global_shortcut::Code> {
    use tauri_plugin_global_shortcut::Code::*;
    Some(match token {
        "KeyA" => KeyA, "KeyB" => KeyB, "KeyC" => KeyC, "KeyD" => KeyD, "KeyE" => KeyE,
        "KeyF" => KeyF, "KeyG" => KeyG, "KeyH" => KeyH, "KeyI" => KeyI, "KeyJ" => KeyJ,
        "KeyK" => KeyK, "KeyL" => KeyL, "KeyM" => KeyM, "KeyN" => KeyN, "KeyO" => KeyO,
        "KeyP" => KeyP, "KeyQ" => KeyQ, "KeyR" => KeyR, "KeyS" => KeyS, "KeyT" => KeyT,
        "KeyU" => KeyU, "KeyV" => KeyV, "KeyW" => KeyW, "KeyX" => KeyX, "KeyY" => KeyY,
        "KeyZ" => KeyZ,
        "Digit0" => Digit0, "Digit1" => Digit1, "Digit2" => Digit2, "Digit3" => Digit3,
        "Digit4" => Digit4, "Digit5" => Digit5, "Digit6" => Digit6, "Digit7" => Digit7,
        "Digit8" => Digit8, "Digit9" => Digit9,
        "F1" => F1, "F2" => F2, "F3" => F3, "F4" => F4, "F5" => F5, "F6" => F6,
        "F7" => F7, "F8" => F8, "F9" => F9, "F10" => F10, "F11" => F11, "F12" => F12,
        "Backquote" => Backquote, "Minus" => Minus, "Equal" => Equal,
        "BracketLeft" => BracketLeft, "BracketRight" => BracketRight, "Backslash" => Backslash,
        "Semicolon" => Semicolon, "Quote" => Quote, "Comma" => Comma, "Period" => Period,
        "Slash" => Slash, "Space" => Space, "Enter" => Enter, "Tab" => Tab,
        "ArrowUp" => ArrowUp, "ArrowDown" => ArrowDown, "ArrowLeft" => ArrowLeft,
        "ArrowRight" => ArrowRight,
        _ => return None,
    })
}

fn parse_summon(combo: &str) -> Result<tauri_plugin_global_shortcut::Shortcut, String> {
    use tauri_plugin_global_shortcut::{Modifiers, Shortcut};
    let parts: Vec<&str> = combo.split('+').filter(|s| !s.is_empty()).collect();
    let (key, mod_parts) = parts.split_last().ok_or_else(|| "empty shortcut".to_string())?;
    let mut mods = Modifiers::empty();
    for m in mod_parts {
        match m.to_ascii_lowercase().as_str() {
            "ctrl" | "control" => mods |= Modifiers::CONTROL,
            "alt" | "option" => mods |= Modifiers::ALT,
            "shift" => mods |= Modifiers::SHIFT,
            "meta" | "super" | "cmd" | "win" => mods |= Modifiers::SUPER,
            other => return Err(format!("unknown modifier: {other}")),
        }
    }
    let code = summon_code(key).ok_or_else(|| format!("unsupported key: {key}"))?;
    Ok(Shortcut::new(if mods.is_empty() { None } else { Some(mods) }, code))
}

// Re-register the global summon hotkey at runtime. Empty combo = disabled.
#[tauri::command]
fn set_summon_shortcut(app: tauri::AppHandle, combo: String) -> Result<(), String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    app.global_shortcut().unregister_all().map_err(|e| e.to_string())?;
    let trimmed = combo.trim();
    if trimmed.is_empty() {
        return Ok(()); // user disabled the summon hotkey
    }
    let sc = parse_summon(trimmed)?;
    app.global_shortcut().register(sc).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(pty::SessionRegistry::default())
        .manage(sftp::SftpRegistry::default())
        .manage(forward::ForwardRegistry::default())
        .manage(vncclient::VncRegistry::default())
        .manage(rdp::RdpRegistry::default())
        .manage(companion::CompanionState::default())
        .manage(commands::TranscriptHandles::default())
        // Global summon hotkey: on press, toggle the main window (show+focus, or
        // hide if it's already the foreground window).
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        if let Some(w) = app.get_webview_window("main") {
                            if w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false) {
                                let _ = w.hide();
                            } else {
                                let _ = w.show();
                                let _ = w.unminimize();
                                let _ = w.set_focus();
                            }
                        }
                    }
                })
                .build(),
        )
        // Remember window geometry (size / position / maximized / fullscreen)
        // across launches. VISIBLE is deliberately NOT tracked: the main window
        // hides to the tray on close, so a tray-menu Quit while hidden would
        // otherwise save "not visible" and the next launch would boot with an
        // invisible window.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED
                        | tauri_plugin_window_state::StateFlags::FULLSCREEN,
                )
                .build(),
        )
        .setup(|app| {
            // Ensure the data directory exists for store + scrollback.
            let data_dir = commands::get_data_dir(app.handle());
            std::fs::create_dir_all(&data_dir).ok();
            // Global PTY output flusher (P1-T1): age-flushes coalesced output
            // for local PTY sessions; parked on a condvar while nothing is
            // pending. Detached; dies with the process.
            pty::start_flusher(app.handle().clone());
            // Scrollback GC runs from the frontend on boot (scrollback_sweep),
            // which passes the keep-set of open tab ids — the backend can't know
            // which tabs are live here in setup().

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Global summon hotkey — Ctrl+Shift+` shows/hides the window from
            // anywhere. The frontend re-applies the user's stored override (or
            // disables it) on boot via set_summon_shortcut.
            {
                use tauri_plugin_global_shortcut::GlobalShortcutExt;
                match parse_summon(DEFAULT_SUMMON) {
                    Ok(sc) => {
                        if let Err(e) = app.global_shortcut().register(sc) {
                            log::warn!("global summon hotkey register failed: {e}");
                        }
                    }
                    Err(e) => log::warn!("default summon parse failed: {e}"),
                }
            }

            // System tray + hide-on-close.
            let show_i =
                MenuItem::with_id(app, "show", "Show Pluto's Terminal", true, None::<&str>)?;
            let quit_i =
                MenuItem::with_id(app, "quit", "Quit (kill all sessions)", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &quit_i])?;

            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Pluto's Terminal — running. Sessions are preserved while in tray.")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.unminimize();
                            let _ = w.set_focus();
                        }
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.unminimize();
                            let _ = w.set_focus();
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            // v0.1.22 close behavior:
            // - Main window (label "main") → hide on close (system tray pattern;
            //   PTYs keep running; tray Show / Quit are the controls).
            // - Secondary windows (label starts with "win-") → close normally.
            //   They have no per-window tray entry, so hiding them would lose
            //   them. Destroying frees their PTYs cleanly via Drop on the
            //   webview unmount; user can re-spawn from any other window via
            //   Ctrl+K → Open new window.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let label = window.label();
                if label == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
                // else: let the close proceed (api.prevent_close not called).
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::read_store,
            commands::write_store,
            commands::pick_directory,
            commands::git_branch_status,
            commands::git_branch_status_many,
            commands::collect_rule_files,
            commands::read_npm_scripts,
            commands::scrollback_load,
            commands::scrollback_delete,
            commands::scrollback_sweep,
            commands::transcript_append,
            commands::transcript_list,
            commands::transcript_read,
            commands::transcript_read_all,
            commands::transcript_sweep,
            commands::recent_files,
            commands::check_command_version,
            commands::mcp_install,
            commands::save_text_to_file,
            commands::spawn_new_window,
            commands::quit_app,
            commands::write_welcome_file,
            commands::open_path,
            commands::worktree_add,
            commands::worktree_remove,
            commands::git_diff,
            commands::gh_pr_create,
            commands::notify,
            set_summon_shortcut,
            sysstats::system_stats,
            commands::list_directory,
            commands::notebook_list,
            commands::notebook_read,
            commands::notebook_write,
            llm::llm_complete,
            llm::llm_stream,
            llm::llm_stream_cancel,
            llm_tools::llm_tool_turn,
            sshconfig::parse_ssh_config,
            sshconfig::ssh_keys_list,
            sshconfig::ssh_key_generate,
            netools::net_ping,
            netools::net_traceroute,
            netools::net_port_scan,
            netools::net_dns,
            netools::net_latency_many,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_ready,
            pty::default_shell,
            pty::ssh_spawn,
            pty::serial_list,
            pty::serial_spawn,
            sftp::sftp_connect,
            sftp::sftp_home,
            sftp::sftp_list,
            sftp::sftp_download,
            sftp::sftp_upload,
            sftp::sftp_mkdir,
            sftp::sftp_remove,
            sftp::sftp_rename,
            sftp::sftp_read_file,
            sftp::sftp_write_file,
            sftp::sftp_disconnect,
            vault::secret_set,
            vault::secret_get,
            vault::secret_delete,
            share::gist_auth_available,
            share::gist_create,
            share::gist_delete,
            sync_git::sync_clone_or_open,
            sync_git::sync_pull,
            sync_git::sync_push,
            forward::port_forward_start,
            forward::port_forward_stop,
            forward::socks_forward_start,
            forward::jump_forward_start,
            vncclient::vnc_connect,
            vncclient::vnc_pointer,
            vncclient::vnc_key,
            vncclient::vnc_disconnect,
            rdp::rdp_connect,
            rdp::rdp_pointer,
            rdp::rdp_key,
            rdp::rdp_disconnect,
            companion::companion_start,
            companion::companion_stop,
            companion::companion_status,
            companion::companion_set_sessions,
            companion::companion_set_snippets,
            companion::companion_set_models,
            companion::companion_notify_finish,
            mcp::manager::mcp_servers_list,
            mcp::manager::mcp_server_add,
            mcp::manager::mcp_server_remove,
            mcp::manager::mcp_list_tools,
            mcp::manager::mcp_call_tool,
            mcp::manager::mcp_reconnect,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Pluto's Terminal")
        .run(|app_handle, event| {
            // Kill every live PTY child when the user truly quits the app.
            if let tauri::RunEvent::ExitRequested { .. } = event {
                if let Some(registry) = app_handle.try_state::<pty::SessionRegistry>() {
                    pty::kill_all(registry.inner());
                }
            }
        });
}
