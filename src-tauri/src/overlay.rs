use crate::settings::AppSettings;
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl};
#[cfg(target_os = "macos")]
use tauri::{Position, Size};
#[cfg(target_os = "macos")]
use tauri_nspanel::{tauri_panel, CollectionBehavior, PanelBuilder, PanelLevel, StyleMask};

#[cfg(target_os = "macos")]
tauri_panel! {
    panel!(MeetingOverlayPanel {
        config: {
            can_become_key_window: true,
            becomes_key_only_if_needed: true,
            is_floating_panel: true
        }
    })
}

// The window is kept barely larger than the card it hosts and resized per UI
// state (see `set_expanded`), because macOS still routes clicks to the window's
// transparent regions — a fixed max-size window would swallow clicks meant for
// the app underneath. Keep these in sync with the card geometry in App.css:
// expanded fits the open card (392w, max-height 320) plus the .ov-stage
// padding (14px sides, 10px anchored edge); collapsed fits the 216px-wide
// status pill (~82px tall) plus the same padding.
const WIDTH: f64 = 420.0;
const HEIGHT: f64 = 340.0;
const COLLAPSED_WIDTH: f64 = 244.0;
const COLLAPSED_HEIGHT: f64 = 96.0;
#[cfg(any(target_os = "macos", test))]
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

#[cfg(any(target_os = "macos", test))]
fn logical_position(
    monitor_position: PhysicalPosition<i32>,
    monitor_size: PhysicalSize<u32>,
    work_area_position: PhysicalPosition<i32>,
    work_area_size: PhysicalSize<u32>,
    scale: f64,
    overlay_position: &str,
    (width, height): (f64, f64),
) -> (f64, f64) {
    let monitor_x = f64::from(monitor_position.x) / scale;
    let monitor_y = f64::from(monitor_position.y) / scale;
    let monitor_width = f64::from(monitor_size.width) / scale;
    let x = monitor_x + (monitor_width - width) / 2.0;
    let y = if overlay_position == "top" {
        monitor_y + TOP_OFFSET
    } else {
        (f64::from(work_area_position.y) + f64::from(work_area_size.height)) / scale
            - height
            - BOTTOM_OFFSET
    };
    (x, y)
}

#[cfg(target_os = "macos")]
fn position(app: &AppHandle, settings: &AppSettings, size: (f64, f64)) -> Option<(f64, f64)> {
    let monitor = monitor_with_cursor(app)?;
    let work_area = monitor.work_area();
    Some(logical_position(
        *monitor.position(),
        *monitor.size(),
        work_area.position,
        work_area.size,
        monitor.scale_factor(),
        &settings.overlay_position,
        size,
    ))
}

fn current_logical_size(window: &tauri::WebviewWindow) -> Option<(f64, f64)> {
    let size = window.inner_size().ok()?;
    let scale = window.scale_factor().ok()?;
    Some((
        f64::from(size.width) / scale,
        f64::from(size.height) / scale,
    ))
}

/// New top-left origin for a resize that keeps the card's anchored edge fixed:
/// horizontally centered, pinned to the top edge for the "top" overlay
/// position and to the bottom edge otherwise. Works from the window's current
/// frame rather than recomputing from the monitor, so a user-dragged overlay
/// stays where it was dropped.
fn anchored_origin(
    origin: (f64, f64),
    old_size: (f64, f64),
    new_size: (f64, f64),
    anchor_top: bool,
) -> (f64, f64) {
    let x = origin.0 + (old_size.0 - new_size.0) / 2.0;
    let y = if anchor_top {
        origin.1
    } else {
        origin.1 + old_size.1 - new_size.1
    };
    (x, y)
}

#[cfg(target_os = "macos")]
pub fn create(app: &AppHandle, settings: &AppSettings) {
    let Some((x, y)) = position(app, settings, (COLLAPSED_WIDTH, COLLAPSED_HEIGHT)) else {
        log::error!("overlay creation failed: no monitor available");
        return;
    };
    match PanelBuilder::<_, MeetingOverlayPanel>::new(app, "meeting-overlay")
        .url(WebviewUrl::App("/?overlay=1".into()))
        .title("Savvy")
        .position(Position::Logical(tauri::LogicalPosition { x, y }))
        .level(PanelLevel::Status)
        .size(Size::Logical(tauri::LogicalSize {
            width: COLLAPSED_WIDTH,
            height: COLLAPSED_HEIGHT,
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

#[cfg(target_os = "macos")]
pub fn show(app: &AppHandle, settings: &AppSettings) {
    let handle = app.clone();
    let settings = settings.clone();
    if let Err(error) = app.run_on_main_thread(move || {
        let Some(window) = handle.get_webview_window("meeting-overlay") else {
            log::error!("meeting overlay show failed: window is missing");
            return;
        };
        // The webview drives the window size via `set_expanded`; showing only
        // re-centers the current footprint on the monitor with the cursor.
        let size = current_logical_size(&window).unwrap_or((COLLAPSED_WIDTH, COLLAPSED_HEIGHT));
        let Some((x, y)) = position(&handle, &settings, size) else {
            log::error!("meeting overlay show failed: no monitor available");
            return;
        };
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

/// Resizes the overlay window to fit the card's expanded or collapsed
/// footprint, keeping the card's anchored screen edge fixed. Invoked by the
/// overlay webview whenever the card grows or finishes shrinking.
pub fn set_expanded(app: &AppHandle, settings: &AppSettings, expanded: bool) {
    let handle = app.clone();
    let anchor_top = settings.overlay_position == "top";
    if let Err(error) = app.run_on_main_thread(move || {
        let Some(window) = handle.get_webview_window("meeting-overlay") else {
            log::error!("meeting overlay resize failed: window is missing");
            return;
        };
        let size = if expanded {
            (WIDTH, HEIGHT)
        } else {
            (COLLAPSED_WIDTH, COLLAPSED_HEIGHT)
        };
        let (Ok(scale), Ok(origin), Some(old_size)) = (
            window.scale_factor(),
            window.outer_position(),
            current_logical_size(&window),
        ) else {
            log::error!("meeting overlay resize failed: window frame unavailable");
            return;
        };
        if (old_size.0 - size.0).abs() < 1.0 && (old_size.1 - size.1).abs() < 1.0 {
            return;
        }
        let (x, y) = anchored_origin(
            (f64::from(origin.x) / scale, f64::from(origin.y) / scale),
            old_size,
            size,
            anchor_top,
        );
        #[cfg(target_os = "windows")]
        if let Err(error) = set_windows_bounds(
            &window,
            (
                (x * scale).round() as i32,
                (y * scale).round() as i32,
                (size.0 * scale).round() as i32,
                (size.1 * scale).round() as i32,
            ),
            false,
        ) {
            log::error!("meeting overlay resize failed: {error}");
            return;
        }
        #[cfg(target_os = "macos")]
        {
            if let Err(error) = window.set_size(Size::Logical(tauri::LogicalSize {
                width: size.0,
                height: size.1,
            })) {
                log::error!("meeting overlay resize failed: {error}");
                return;
            }
            if let Err(error) =
                window.set_position(Position::Logical(tauri::LogicalPosition { x, y }))
            {
                log::error!("meeting overlay position failed: {error}");
                return;
            }
        }
        log::info!(
            "meeting overlay {} to {:.0}x{:.0}",
            if expanded { "expanded" } else { "collapsed" },
            size.0,
            size.1
        );
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

#[cfg(target_os = "windows")]
pub fn create(app: &AppHandle, _settings: &AppSettings) {
    if let Err(error) = tauri::WebviewWindowBuilder::new(
        app,
        "meeting-overlay",
        WebviewUrl::App("/?overlay=1".into()),
    )
    .title("Savvy")
    .inner_size(COLLAPSED_WIDTH, COLLAPSED_HEIGHT)
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .resizable(false)
    .maximizable(false)
    .minimizable(false)
    .always_on_top(true)
    .skip_taskbar(true)
    // Showing must not steal focus, but clicking can focus accessible controls.
    .focused(false)
    .focusable(true)
    .visible(false)
    .build()
    {
        log::error!("meeting overlay creation failed: {error}");
    }
}

#[cfg(any(target_os = "windows", test))]
fn windows_bounds(
    work_position: PhysicalPosition<i32>,
    work_size: PhysicalSize<u32>,
    scale: f64,
    size: (f64, f64),
    anchor_top: bool,
) -> (i32, i32, i32, i32) {
    let width = (size.0 * scale).round() as i32;
    let height = (size.1 * scale).round() as i32;
    let margin = (BOTTOM_OFFSET * scale).round() as i32;
    let x = work_position.x + (work_size.width as i32 - width) / 2;
    let y = if anchor_top {
        work_position.y + margin
    } else {
        work_position.y + work_size.height as i32 - height - margin
    };
    (x, y, width, height)
}

#[cfg(target_os = "windows")]
fn set_windows_bounds(
    window: &tauri::WebviewWindow,
    bounds: (i32, i32, i32, i32),
    show: bool,
) -> Result<(), String> {
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, HWND_TOPMOST, SWP_NOACTIVATE, SWP_SHOWWINDOW,
    };
    let hwnd = window.hwnd().map_err(|error| error.to_string())?;
    let mut flags = SWP_NOACTIVATE;
    if show {
        flags |= SWP_SHOWWINDOW;
    }
    // Called on the UI thread with a live window. Physical coordinates avoid
    // conversion through the previous monitor's DPI, as in Handy's overlay.
    unsafe {
        SetWindowPos(
            hwnd,
            Some(HWND_TOPMOST),
            bounds.0,
            bounds.1,
            bounds.2,
            bounds.3,
            flags,
        )
    }
    .map_err(|error| error.to_string())
}

#[cfg(target_os = "windows")]
pub fn show(app: &AppHandle, settings: &AppSettings) {
    let handle = app.clone();
    let anchor_top = settings.overlay_position == "top";
    if let Err(error) = app.run_on_main_thread(move || {
        let Some(window) = handle.get_webview_window("meeting-overlay") else {
            return;
        };
        let Some(monitor) = monitor_with_cursor(&handle) else {
            return;
        };
        let size = current_logical_size(&window).unwrap_or((COLLAPSED_WIDTH, COLLAPSED_HEIGHT));
        let area = monitor.work_area();
        let bounds = windows_bounds(
            area.position,
            area.size,
            monitor.scale_factor(),
            size,
            anchor_top,
        );
        // Crossing a DPI boundary can resize the window during the first move.
        // Reassert the destination bounds after showing, as Handy does.
        if let Err(error) = set_windows_bounds(&window, bounds, true)
            .and_then(|()| set_windows_bounds(&window, bounds, false))
        {
            log::error!("meeting overlay show failed: {error}");
        }
    }) {
        log::error!("meeting overlay main-thread dispatch failed: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_position_uses_destination_dpi_and_taskbar_work_area() {
        assert_eq!(
            windows_bounds(
                PhysicalPosition::new(-2560, 0),
                PhysicalSize::new(2560, 1400),
                1.5,
                (420.0, 340.0),
                false
            ),
            (-1595, 867, 630, 510)
        );
        assert_eq!(
            windows_bounds(
                PhysicalPosition::new(1920, 40),
                PhysicalSize::new(1920, 1040),
                1.0,
                (244.0, 96.0),
                true
            ),
            (2758, 55, 244, 96)
        );
    }

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
                (WIDTH, HEIGHT),
            ),
            (650.0, 340.0)
        );
    }

    #[test]
    fn resize_pins_the_anchored_edge_and_keeps_the_center() {
        // Bottom overlay: the bottom edge (y + height) must not move.
        assert_eq!(
            anchored_origin((650.0, 340.0), (420.0, 340.0), (244.0, 96.0), false),
            (738.0, 584.0)
        );
        // Top overlay: the top edge must not move.
        assert_eq!(
            anchored_origin((650.0, 32.0), (244.0, 96.0), (420.0, 340.0), true),
            (562.0, 32.0)
        );
    }
}
