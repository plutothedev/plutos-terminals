// Pluto's Terminals — Tauri app entry.
//
// Lifted from Lyfe's lib.rs with KB/journal init removed and rebranded.
// Closing the window hides to the system tray so PTY sessions keep running
// in the background. Only an explicit "Quit" from the tray menu fires
// RunEvent::ExitRequested → kill_all() so no shell children orphan.

mod commands;
mod pty;
mod sftp;
mod vault;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(pty::SessionRegistry::default())
        .manage(sftp::SftpRegistry::default())
        .setup(|app| {
            // Ensure the data directory exists for store + scrollback.
            let data_dir = commands::get_data_dir(app.handle());
            std::fs::create_dir_all(&data_dir).ok();

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // System tray + hide-on-close.
            let show_i = MenuItem::with_id(app, "show", "Show Pluto's Terminals", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(
                app,
                "quit",
                "Quit (kill all sessions)",
                true,
                None::<&str>,
            )?;
            let menu = Menu::with_items(app, &[&show_i, &quit_i])?;

            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Pluto's Terminals — running. Sessions are preserved while in tray.")
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
            commands::read_npm_scripts,
            commands::scrollback_save,
            commands::scrollback_load,
            commands::scrollback_delete,
            commands::transcript_append,
            commands::recent_files,
            commands::check_command_version,
            commands::mcp_install,
            commands::save_text_to_file,
            commands::spawn_new_window,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::default_shell,
            pty::ssh_spawn,
            sftp::sftp_connect,
            sftp::sftp_home,
            sftp::sftp_list,
            sftp::sftp_download,
            sftp::sftp_upload,
            sftp::sftp_mkdir,
            sftp::sftp_remove,
            sftp::sftp_rename,
            sftp::sftp_disconnect,
            vault::secret_set,
            vault::secret_get,
            vault::secret_delete,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Pluto's Terminals")
        .run(|app_handle, event| {
            // Kill every live PTY child when the user truly quits the app.
            if let tauri::RunEvent::ExitRequested { .. } = event {
                if let Some(registry) = app_handle.try_state::<pty::SessionRegistry>() {
                    pty::kill_all(registry.inner());
                }
            }
        });
}
