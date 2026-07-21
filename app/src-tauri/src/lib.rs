use tauri::webview::WebviewBuilder;
use tauri::{LogicalPosition, LogicalSize, Manager, WebviewUrl, Window};

/// Label of the single child webview used for the live research view.
const RESEARCH_LABEL: &str = "research";

/// Only allow the research view to display GitHub pages.
fn parse_github_url(url: &str) -> Result<tauri::Url, String> {
    let parsed: tauri::Url = url.parse().map_err(|_| format!("Invalid URL: {url}"))?;
    let host_ok = parsed
        .host_str()
        .is_some_and(|h| h == "github.com" || h == "www.github.com");
    if parsed.scheme() != "https" || !host_ok {
        return Err(format!("URL not allowed in research view: {url}"));
    }
    Ok(parsed)
}

/// Open (or re-target) the research child webview at the given logical rect.
#[tauri::command]
fn open_research_view(
    window: Window,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let parsed = parse_github_url(&url)?;

    if let Some(existing) = window.get_webview(RESEARCH_LABEL) {
        existing.navigate(parsed).map_err(|e| e.to_string())?;
        existing
            .set_position(LogicalPosition::new(x, y))
            .map_err(|e| e.to_string())?;
        existing
            .set_size(LogicalSize::new(width, height))
            .map_err(|e| e.to_string())?;
        existing.show().map_err(|e| e.to_string())?;
        return Ok(());
    }

    let builder = WebviewBuilder::new(RESEARCH_LABEL, WebviewUrl::External(parsed));
    window
        .add_child(
            builder,
            LogicalPosition::new(x, y),
            LogicalSize::new(width, height),
        )
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Navigate the existing research webview to a new GitHub URL.
#[tauri::command]
fn navigate_research_view(window: Window, url: String) -> Result<(), String> {
    let parsed = parse_github_url(&url)?;
    let webview = window
        .get_webview(RESEARCH_LABEL)
        .ok_or("Research view is not open.")?;
    webview.navigate(parsed).map_err(|e| e.to_string())
}

/// Reposition/resize the research webview (logical pixels, i.e. CSS px).
#[tauri::command]
fn set_research_view_rect(
    window: Window,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let webview = window
        .get_webview(RESEARCH_LABEL)
        .ok_or("Research view is not open.")?;
    webview
        .set_position(LogicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    webview
        .set_size(LogicalSize::new(width, height))
        .map_err(|e| e.to_string())
}

/// Close the research webview if it exists.
#[tauri::command]
fn close_research_view(window: Window) -> Result<(), String> {
    if let Some(webview) = window.get_webview(RESEARCH_LABEL) {
        webview.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());

    builder
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            open_research_view,
            navigate_research_view,
            set_research_view_rect,
            close_research_view
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
