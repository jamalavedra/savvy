use tauri::{
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    App, AppHandle, Emitter, Manager, WindowEvent, Wry,
};

struct StartMenuItem(MenuItem<Wry>);

pub fn setup(app: &mut App, visible: bool) -> tauri::Result<()> {
    let version = MenuItem::with_id(
        app,
        "version",
        format!("Savvy {}", app.package_info().version),
        false,
        None::<&str>,
    )?;
    let start = MenuItem::with_id(
        app,
        "start-listening",
        "Start listening",
        true,
        None::<&str>,
    )?;
    let open = MenuItem::with_id(app, "open", "Open Savvy", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings…", true, Some("CmdOrCtrl+,"))?;
    let check_updates = MenuItem::with_id(
        app,
        "check-updates",
        "Check for Updates…",
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "Quit Savvy", true, Some("CmdOrCtrl+Q"))?;
    let separator_1 = PredefinedMenuItem::separator(app)?;
    let separator_2 = PredefinedMenuItem::separator(app)?;
    let separator_3 = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(
        app,
        &[
            &version,
            &separator_1,
            &start,
            &open,
            &separator_2,
            &settings,
            &check_updates,
            &separator_3,
            &quit,
        ],
    )?;
    let icon = Image::from_bytes(include_bytes!("../icons/tray-thinking.png"))?;

    let tray = TrayIconBuilder::with_id("savvy")
        .icon(icon)
        .icon_as_template(cfg!(target_os = "macos"))
        .tooltip("Savvy — ready to listen")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "start-listening" => {
                log::debug!("tray start listening selected");
                let _ = app.emit("savvy://start-listening", ());
            }
            "open" => show_main_window(app),
            "settings" => {
                show_main_window(app);
                let _ = app.emit("savvy://open-settings", ());
            }
            "check-updates" => {
                show_main_window(app);
                let _ = app.emit("savvy://check-updates", ());
            }
            "quit" => crate::quit(app),
            _ => {}
        })
        .build(app)?;
    tray.set_visible(visible)?;
    app.manage(StartMenuItem(start));

    if let Some(window) = app.get_webview_window("main") {
        let window_to_hide = window.clone();
        window.on_window_event(move |event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                #[cfg(target_os = "windows")]
                if !window_to_hide
                    .app_handle()
                    .state::<crate::AppState>()
                    .settings
                    .lock()
                    .map(|settings| settings.show_tray_icon)
                    .unwrap_or(true)
                {
                    api.prevent_close();
                    crate::quit(window_to_hide.app_handle());
                    return;
                }
                api.prevent_close();
                let _ = window_to_hide.hide();
            }
        });
    }
    Ok(())
}

pub(crate) fn set_visible(app: &AppHandle, visible: bool) -> Result<(), String> {
    app.tray_by_id("savvy")
        .ok_or_else(|| "Savvy tray icon is unavailable".to_owned())?
        .set_visible(visible)
        .map_err(|error| error.to_string())
}

pub(crate) fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub(crate) fn update_shortcut_label(app: &AppHandle, shortcut: &str) {
    let label = if cfg!(target_os = "windows") {
        shortcut
            .replace("Command", "Win")
            .replace("Control", "Ctrl")
            .replace("Option", "Alt")
    } else {
        shortcut
            .replace("Command", "⌘")
            .replace("Control", "⌃")
            .replace("Option", "⌥")
            .replace("Shift", "⇧")
            .replace('+', "")
    };
    let _ = app
        .state::<StartMenuItem>()
        .0
        .set_text(format!("Start listening · {label}"));
}
