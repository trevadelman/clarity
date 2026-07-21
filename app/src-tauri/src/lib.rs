use std::sync::Mutex;

use tauri::webview::WebviewBuilder;
use tauri::{LogicalPosition, LogicalSize, Manager, State, WebviewUrl, Window};

/// Label of the single child webview used for the live research view.
const RESEARCH_LABEL: &str = "research";

/// Browser-equivalent user agent for browse/research webviews. Embedded
/// webviews default to UAs that sites (notably Google) sniff as an
/// unsupported browser; advertising the engine we actually are fixes
/// login and "upgrade your browser" banners. Bump versions occasionally.
#[cfg(target_os = "macos")]
const BROWSER_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) \
AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15";
#[cfg(not(target_os = "macos"))]
const BROWSER_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) \
AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 \
Edg/126.0.0.0";

/// Maximum number of live browse-tab webviews. Each is a full native
/// webview instance, so evict least-recently-used beyond this cap
/// (evicted tabs simply reload on next open).
const TAB_CAP: usize = 4;

/// Tracks open browse tabs in most-recently-used order (front = newest).
#[derive(Default)]
struct TabState {
    mru: Mutex<Vec<String>>,
}

/// Webview label for a browse tab id.
fn tab_label(id: &str) -> String {
    format!("tab-{id}")
}

/// Browse tabs may load any http(s) page; everything else is rejected
/// (file:, data:, javascript:, ...).
fn parse_http_url(url: &str) -> Result<tauri::Url, String> {
    let parsed: tauri::Url = url.parse().map_err(|_| format!("Invalid URL: {url}"))?;
    match parsed.scheme() {
        "https" | "http" => Ok(parsed),
        _ => Err(format!("URL not allowed in browse tab: {url}")),
    }
}

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

    let builder = WebviewBuilder::new(RESEARCH_LABEL, WebviewUrl::External(parsed))
        .user_agent(BROWSER_UA);
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

// --------------------------------------------------------------------------
// Browse-mode tabs: multiple persistent child webviews, one visible at a
// time. Switching shows an already-loaded webview (instant, stateful)
// instead of navigating a shared one.
// --------------------------------------------------------------------------

/// Move `id` to the front of the MRU list and return labels to evict
/// (anything beyond TAB_CAP).
fn touch_tab(state: &State<TabState>, id: &str) -> Vec<String> {
    let mut mru = state.mru.lock().unwrap();
    mru.retain(|x| x != id);
    mru.insert(0, id.to_string());
    let keep = TAB_CAP.min(mru.len());
    mru.split_off(keep).iter().map(|x| tab_label(x)).collect()
}

/// Hide every tab webview except `keep` (pass None to hide all).
fn hide_other_tabs(window: &Window, keep: Option<&str>) {
    let keep_label = keep.map(tab_label);
    for webview in window.webviews() {
        let label = webview.label().to_string();
        if label.starts_with("tab-") && Some(&label) != keep_label.as_ref() {
            let _ = webview.hide();
        }
    }
}

/// Open a browse tab: create its webview if needed, otherwise just show
/// it (preserving its loaded state). Hides all other tabs and applies
/// LRU eviction beyond the cap.
#[tauri::command]
fn open_tab(
    window: Window,
    state: State<TabState>,
    id: String,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let parsed = parse_http_url(&url)?;
    let label = tab_label(&id);

    let evict = touch_tab(&state, &id);
    for victim in evict {
        if let Some(webview) = window.get_webview(&victim) {
            let _ = webview.close();
        }
    }

    hide_other_tabs(&window, Some(&id));

    if let Some(existing) = window.get_webview(&label) {
        existing
            .set_position(LogicalPosition::new(x, y))
            .map_err(|e| e.to_string())?;
        existing
            .set_size(LogicalSize::new(width, height))
            .map_err(|e| e.to_string())?;
        existing.show().map_err(|e| e.to_string())?;
        return Ok(());
    }

    let builder = WebviewBuilder::new(&label, WebviewUrl::External(parsed))
        .user_agent(BROWSER_UA);
    window
        .add_child(
            builder,
            LogicalPosition::new(x, y),
            LogicalSize::new(width, height),
        )
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Reposition/resize the visible tab webviews (logical pixels).
#[tauri::command]
fn set_tab_rect(
    window: Window,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    for webview in window.webviews() {
        if webview.label().starts_with("tab-") {
            webview
                .set_position(LogicalPosition::new(x, y))
                .map_err(|e| e.to_string())?;
            webview
                .set_size(LogicalSize::new(width, height))
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Close one browse tab.
#[tauri::command]
fn close_tab(window: Window, state: State<TabState>, id: String) -> Result<(), String> {
    state.mru.lock().unwrap().retain(|x| x != &id);
    if let Some(webview) = window.get_webview(&tab_label(&id)) {
        webview.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Hide all browse tabs without destroying them (leaving /browse keeps
/// page state for when the user comes back).
#[tauri::command]
fn hide_all_tabs(window: Window) -> Result<(), String> {
    hide_other_tabs(&window, None);
    Ok(())
}

/// Destroy all browse tabs.
#[tauri::command]
fn close_all_tabs(window: Window, state: State<TabState>) -> Result<(), String> {
    state.mru.lock().unwrap().clear();
    for webview in window.webviews() {
        if webview.label().starts_with("tab-") {
            let _ = webview.close();
        }
    }
    Ok(())
}

/// Run history navigation (back/forward) or reload in a tab webview.
#[tauri::command]
fn tab_history(window: Window, id: String, action: String) -> Result<(), String> {
    let webview = window
        .get_webview(&tab_label(&id))
        .ok_or("Tab is not open.")?;
    let js = match action.as_str() {
        "back" => "history.back()",
        "forward" => "history.forward()",
        "reload" => "location.reload()",
        _ => return Err(format!("Unknown history action: {action}")),
    };
    webview.eval(js).map_err(|e| e.to_string())
}

/// Navigate an open browse tab to a new http(s) URL (used by the AI's
/// navigate tool; same URL policy as opening tabs).
#[tauri::command]
fn navigate_tab(window: Window, id: String, url: String) -> Result<(), String> {
    let parsed = parse_http_url(&url)?;
    let webview = window
        .get_webview(&tab_label(&id))
        .ok_or("Tab is not open.")?;
    webview.navigate(parsed).map_err(|e| e.to_string())
}

/// Evaluate JS inside a browse tab and return its (string) result.
///
/// Tauri's `Webview::eval` is fire-and-forget, so for the AI page-extraction
/// path we go one level down: on macOS, WKWebView's
/// `evaluateJavaScript:completionHandler:` delivers the completion value.
/// The injected JS must evaluate to a string (callers JSON.stringify
/// structured results).
#[tauri::command]
async fn eval_in_tab(window: Window, id: String, js: String) -> Result<String, String> {
    let webview = window
        .get_webview(&tab_label(&id))
        .ok_or("Tab is not open.")?;

    #[cfg(target_os = "macos")]
    {
        use std::sync::mpsc;
        use std::time::Duration;

        let (tx, rx) = mpsc::channel::<Result<String, String>>();
        webview
            .with_webview(move |platform| {
                use block2::RcBlock;
                use objc2::runtime::AnyObject;
                use objc2_foundation::{NSError, NSString};
                use objc2_web_kit::WKWebView;

                let wk: &WKWebView = unsafe { &*platform.inner().cast() };
                let handler = RcBlock::new(move |result: *mut AnyObject, error: *mut NSError| {
                    let out = if !error.is_null() {
                        Err(unsafe { (*error).localizedDescription() }.to_string())
                    } else if result.is_null() {
                        Ok(String::new())
                    } else {
                        let obj = unsafe { &*result };
                        match obj.downcast_ref::<NSString>() {
                            Some(s) => Ok(s.to_string()),
                            None => Err("Page script did not return a string.".into()),
                        }
                    };
                    let _ = tx.send(out);
                });
                unsafe {
                    wk.evaluateJavaScript_completionHandler(
                        &NSString::from_str(&js),
                        Some(&handler),
                    );
                }
            })
            .map_err(|e| e.to_string())?;

        // The completion handler fires on the main thread; wait for it on a
        // blocking-friendly thread so we don't stall the async runtime.
        tauri::async_runtime::spawn_blocking(move || {
            rx.recv_timeout(Duration::from_secs(10))
                .map_err(|_| "Timed out reading from the page.".to_string())?
        })
        .await
        .map_err(|e| e.to_string())?
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = js;
        Err("Page extraction is not implemented on this platform yet.".into())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());

    builder
        .manage(TabState::default())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            open_research_view,
            navigate_research_view,
            set_research_view_rect,
            close_research_view,
            open_tab,
            set_tab_rect,
            close_tab,
            hide_all_tabs,
            close_all_tabs,
            tab_history,
            navigate_tab,
            eval_in_tab
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
