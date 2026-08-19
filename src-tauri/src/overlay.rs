use crate::settings::AppSettings;
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, Position, Size, WebviewUrl};
use tauri_nspanel::{tauri_panel, CollectionBehavior, PanelBuilder, PanelLevel, StyleMask};

tauri_panel! {
    panel!(MeetingOverlayPanel {
        config: {
            can_become_key_window: true,
            becomes_key_only_if_needed: true,
            is_floating_panel: true
        }
    })
}

const WIDTH: f64 = 420.0;
const HEIGHT: f64 = 340.0;
const TOP_OFFSET: f64 = 32.0;
const BOTTOM_OFFSET: f64 = 15.0;

fn monitor_with_cursor(app: &AppHandle) -> Option<tauri::Monitor> {
    let cursor = app.cursor_position().ok()?;
    app.available_monitors()
        .ok()?
        .into_iter()
        .find(|monitor| {
            let position = monitor.position();
            let size = monitor.size();
            cursor.x >= f64::from(position.x)
                && cursor.x < f64::from(position.x) + f64::from(size.width)
                && cursor.y >= f64::from(position.y)
                && cursor.y < f64::from(position.y) + f64::from(size.height)
        })
        .or_else(|| app.primary_monitor().ok().flatten())
}

fn logical_position(
    monitor_position: PhysicalPosition<i32>,
    monitor_size: PhysicalSize<u32>,
    work_area_position: PhysicalPosition<i32>,
    work_area_size: PhysicalSize<u32>,
    scale: f64,
    overlay_position: &str,
) -> (f64, f64) {
    let monitor_x = f64::from(monitor_position.x) / scale;
    let monitor_y = f64::from(monitor_position.y) / scale;
    let monitor_width = f64::from(monitor_size.width) / scale;
    let x = monitor_x + (monitor_width - WIDTH) / 2.0;
    let y = if overlay_position == "top" {
        monitor_y + TOP_OFFSET
    } else {
        (f64::from(work_area_position.y) + f64::from(work_area_size.height)) / scale
            - HEIGHT
            - BOTTOM_OFFSET
    };
    (x, y)
}

fn position(app: &AppHandle, settings: &AppSettings) -> Option<(f64, f64)> {
    let monitor = monitor_with_cursor(app)?;
    let work_area = monitor.work_area();
    Some(logical_position(
        *monitor.position(),
        *monitor.size(),
        work_area.position,
        work_area.size,
        monitor.scale_factor(),
        &settings.overlay_position,
    ))
}

pub fn create(app: &AppHandle, settings: &AppSettings) {
    let Some((x, y)) = position(app, settings) else {
        log::error!("overlay creation failed: no monitor available");
        return;
    };
    match PanelBuilder::<_, MeetingOverlayPanel>::new(app, "meeting-overlay")
        .url(WebviewUrl::App("/?overlay=1".into()))
        .title("Savvy")
        .position(Position::Logical(tauri::LogicalPosition { x, y }))
        .level(PanelLevel::Status)
        .size(Size::Logical(tauri::LogicalSize {
            width: WIDTH,
            height: HEIGHT,
        }))
        .has_shadow(false)
        .transparent(true)
        .no_activate(true)
        .corner_radius(0.0)
        .style_mask(StyleMask::empty().borderless().nonactivating_panel())
        .with_window(|window| {
            window
                .decorations(false)
                .transparent(true)
                .accept_first_mouse(true)
        })
        .collection_behavior(
            CollectionBehavior::new()
                .can_join_all_spaces()
                .full_screen_auxiliary(),
        )
        .build()
    {
        Ok(panel) => {
            panel.hide();
            log::info!("meeting overlay created hidden at x={x:.0} y={y:.0}");
        }
        Err(error) => log::error!("meeting overlay creation failed: {error}"),
    }
}

pub fn show(app: &AppHandle, settings: &AppSettings) {
    let handle = app.clone();
    let settings = settings.clone();
    if let Err(error) = app.run_on_main_thread(move || {
        let Some(window) = handle.get_webview_window("meeting-overlay") else {
            log::error!("meeting overlay show failed: window is missing");
            return;
        };
        let Some((x, y)) = position(&handle, &settings) else {
            log::error!("meeting overlay show failed: no monitor available");
            return;
        };
        if let Err(error) = window.set_size(Size::Logical(tauri::LogicalSize {
            width: WIDTH,
            height: HEIGHT,
        })) {
            log::error!("meeting overlay resize failed: {error}");
            return;
        }
        if let Err(error) = window.set_position(Position::Logical(tauri::LogicalPosition { x, y }))
        {
            log::error!("meeting overlay position failed: {error}");
            return;
        }
        match window.show() {
            Ok(()) => log::info!("meeting overlay shown at x={x:.0} y={y:.0}"),
            Err(error) => log::error!("meeting overlay show failed: {error}"),
        }
    }) {
        log::error!("meeting overlay main-thread dispatch failed: {error}");
    }
}

pub fn hide(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("meeting-overlay") {
        match window.hide() {
            Ok(()) => log::info!("meeting overlay hidden"),
            Err(error) => log::error!("meeting overlay hide failed: {error}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retina_bottom_position_uses_logical_coordinates() {
        assert_eq!(
            logical_position(
                PhysicalPosition::new(0, 0),
                PhysicalSize::new(3440, 1440),
                PhysicalPosition::new(0, 0),
                PhysicalSize::new(3440, 1390),
                2.0,
                "bottom",
            ),
            (650.0, 340.0)
        );
    }
}
