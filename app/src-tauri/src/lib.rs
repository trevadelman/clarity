use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

use tauri::webview::{NewWindowResponse, WebviewBuilder};
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

/// Unique label for each popup window (labels must never repeat within a
/// session, even after a popup closes).
fn next_popup_label() -> String {
    static COUNTER: AtomicUsize = AtomicUsize::new(0);
    format!("popup-{}", COUNTER.fetch_add(1, Ordering::Relaxed))
}

/// Parse a `#rrggbb` hex color (as sent by the frontend theme) into a
/// webview background color.
fn parse_hex_color(hex: &str) -> Option<tauri::webview::Color> {
    let hex = hex.strip_prefix('#')?;
    if hex.len() != 6 {
        return None;
    }
    let r = u8::from_str_radix(&hex[0..2], 16).ok()?;
    let g = u8::from_str_radix(&hex[2..4], 16).ok()?;
    let b = u8::from_str_radix(&hex[4..6], 16).ok()?;
    Some(tauri::webview::Color(r, g, b, 255))
}

/// Create a child webview with the browser UA reliably applied to its very
/// first real request. Builder options alone race the initial navigation on
/// macOS (the first request leaves with the default UA; see Gmail's
/// "unsupported browser" banner), so: create at about:blank, set
/// `customUserAgent` natively, then navigate explicitly.
fn add_browser_webview(
    window: &Window,
    label: &str,
    url: tauri::Url,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    bg: Option<&str>,
) -> Result<(), String> {
    let blank: tauri::Url = "about:blank".parse().unwrap();
    let mut builder =
        WebviewBuilder::new(label, WebviewUrl::External(blank)).user_agent(BROWSER_UA);
    // Themed background: avoids the white flash before a page's first paint
    // (worst in dark mode).
    if let Some(color) = bg.and_then(parse_hex_color) {
        builder = builder.background_color(color);
    }
    // OAuth popups: sites authenticate via window.open (Google, Microsoft,
    // GitHub social login...). Open those as real decorated windows that
    // share the opener's web context so window.opener/postMessage plumbing
    // works and the popup can close itself when the flow completes.
    let app = window.app_handle().clone();
    builder = builder.on_new_window(move |url, features| {
        if !matches!(url.scheme(), "https" | "http") {
            return NewWindowResponse::Deny;
        }
        let size = features
            .size()
            .unwrap_or(LogicalSize::new(480.0, 640.0));
        #[allow(unused_mut)]
        let mut wb = tauri::WebviewWindowBuilder::new(
            &app,
            next_popup_label(),
            WebviewUrl::External(url),
        )
        .title("Sign in")
        .inner_size(size.width, size.height)
        .user_agent(BROWSER_UA);
        // Each platform requires the popup to share the opener's web context.
        #[cfg(target_os = "macos")]
        {
            wb = wb.with_webview_configuration(features.opener().target_configuration.clone());
        }
        #[cfg(windows)]
        {
            wb = wb.with_environment(features.opener().environment.clone());
        }
        match wb.build() {
            Ok(window) => NewWindowResponse::Create { window },
            Err(e) => {
                log::warn!("failed to open popup window: {e}");
                NewWindowResponse::Deny
            }
        }
    });
    log::info!("add_browser_webview({label}): adding child webview");
    let webview = window
        .add_child(
            builder,
            LogicalPosition::new(x, y),
            LogicalSize::new(width, height),
        )
        .map_err(|e| e.to_string())?;
    log::info!("add_browser_webview({label}): child added");

    #[cfg(target_os = "macos")]
    webview
        .with_webview(|platform| {
            use objc2_foundation::NSString;
            use objc2_web_kit::WKWebView;
            let wk: &WKWebView = unsafe { &*platform.inner().cast() };
            unsafe { wk.setCustomUserAgent(Some(&NSString::from_str(BROWSER_UA))) };
        })
        .map_err(|e| e.to_string())?;

    // Same belt-and-suspenders on Windows: set the UA on the WebView2
    // settings before the first real navigation, in case the builder
    // option races it like WKWebView's does. Non-fatal: the builder's
    // user_agent() already applies on Windows; this only closes a
    // theoretical race.
    #[cfg(windows)]
    {
        log::info!("add_browser_webview({label}): setting WebView2 UA");
        let ua_result = webview.with_webview(|platform| {
            use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings2;
            use windows::core::{Interface, HSTRING, PCWSTR};

            let apply = || -> windows::core::Result<()> {
                let core = unsafe { platform.controller().CoreWebView2() }?;
                let settings: ICoreWebView2Settings2 = unsafe { core.Settings() }?.cast()?;
                let ua = HSTRING::from(BROWSER_UA);
                unsafe { settings.SetUserAgent(PCWSTR(ua.as_ptr())) }
            };
            if let Err(e) = apply() {
                log::warn!("failed to set WebView2 user agent: {e}");
            }
        });
        if let Err(e) = ua_result {
            log::warn!("with_webview for UA failed: {e}");
        }
        log::info!("add_browser_webview({label}): UA step done");
    }

    log::info!("add_browser_webview({label}): navigating to {url}");
    let out = webview.navigate(url).map_err(|e| e.to_string());
    log::info!("add_browser_webview({label}): navigate returned {out:?}");
    out
}

/// Create a browser child webview on the main thread and wait for the
/// result. On Windows, WebView2 controller creation completes via a
/// callback that must be delivered on the UI thread — calling `add_child`
/// from a command worker thread deadlocks the whole app (`wait_with_pump`
/// spins forever). macOS doesn't strictly need the hop but shares the one
/// code path.
async fn add_browser_webview_on_main(
    window: Window,
    label: String,
    url: tauri::Url,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    bg: Option<String>,
) -> Result<(), String> {
    use std::sync::mpsc;
    use std::time::Duration;

    let (tx, rx) = mpsc::channel::<Result<(), String>>();
    let win = window.clone();
    window
        .app_handle()
        .run_on_main_thread(move || {
            let _ = tx.send(add_browser_webview(
                &win,
                &label,
                url,
                x,
                y,
                width,
                height,
                bg.as_deref(),
            ));
        })
        .map_err(|e| e.to_string())?;

    tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(Duration::from_secs(15))
            .map_err(|_| "Timed out creating the browser view.".to_string())?
    })
    .await
    .map_err(|e| e.to_string())?
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
async fn open_research_view(
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

    add_browser_webview_on_main(window, RESEARCH_LABEL.into(), parsed, x, y, width, height, None)
        .await
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
async fn open_tab(
    window: Window,
    state: State<'_, TabState>,
    id: String,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    bg: Option<String>,
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

    add_browser_webview_on_main(window, label, parsed, x, y, width, height, bg).await
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

/// Reload is always a "hard" reload: stale service workers / Cache API
/// entries are the classic way SPAs (Gmail) keep serving a degraded shell
/// cached under an old user agent, so purge both before reloading. Cookies
/// and logins are untouched. Falls back to a plain reload on any error.
const HARD_RELOAD_JS: &str = r#"(async () => {
  try {
    const regs = await navigator.serviceWorker?.getRegistrations?.() ?? [];
    await Promise.all(regs.map((r) => r.unregister()));
    const keys = await caches?.keys?.() ?? [];
    await Promise.all(keys.map((k) => caches.delete(k)));
  } catch {}
  location.reload();
})()"#;

/// Run history navigation (back/forward) or reload in a tab webview.
#[tauri::command]
fn tab_history(window: Window, id: String, action: String) -> Result<(), String> {
    let webview = window
        .get_webview(&tab_label(&id))
        .ok_or("Tab is not open.")?;
    let js = match action.as_str() {
        "back" => "history.back()",
        "forward" => "history.forward()",
        "reload" => HARD_RELOAD_JS,
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

    #[cfg(windows)]
    {
        use std::sync::mpsc;
        use std::time::Duration;

        let (tx, rx) = mpsc::channel::<Result<String, String>>();
        webview
            .with_webview(move |platform| {
                use webview2_com::ExecuteScriptCompletedHandler;
                use windows::core::{HSTRING, PCWSTR};

                let core = match unsafe { platform.controller().CoreWebView2() } {
                    Ok(core) => core,
                    Err(e) => {
                        let _ = tx.send(Err(e.to_string()));
                        return;
                    }
                };
                let handler_tx = tx.clone();
                let handler = ExecuteScriptCompletedHandler::create(Box::new(
                    move |error_code, result_json: String| {
                        let out = match error_code {
                            Ok(()) => decode_execute_script_result(&result_json),
                            Err(e) => Err(e.to_string()),
                        };
                        let _ = handler_tx.send(out);
                        Ok(())
                    },
                ));
                let js = HSTRING::from(js);
                if let Err(e) = unsafe { core.ExecuteScript(PCWSTR(js.as_ptr()), &handler) } {
                    let _ = tx.send(Err(e.to_string()));
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

    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = js;
        Err("Page extraction is not implemented on this platform yet.".into())
    }
}

/// Open devtools for the main app webview — the "Open console" button in
/// Settings, for debugging shipped builds (devtools feature is enabled in
/// release).
#[tauri::command]
fn open_devtools(window: Window) {
    if let Some(webview) = window.get_webview("main") {
        webview.open_devtools();
    }
}

/// Clear all website data (cookies, local/session storage, IndexedDB,
/// service workers, caches) for the browse/research webviews — the
/// "sign me out of everything" escape hatch in Settings. App state is
/// untouched: settings/library live in tauri-plugin-store files.
#[tauri::command]
async fn clear_browsing_data(window: Window, state: State<'_, TabState>) -> Result<(), String> {
    use std::sync::mpsc;
    use std::time::Duration;

    let (tx, rx) = mpsc::channel::<Result<(), String>>();

    #[cfg(target_os = "macos")]
    {
        // The default WKWebsiteDataStore is shared by every child webview;
        // clearing it clears them all. Must run on the main thread.
        let tx = tx.clone();
        window
            .app_handle()
            .run_on_main_thread(move || {
                use block2::RcBlock;
                use objc2_foundation::{MainThreadMarker, NSDate};
                use objc2_web_kit::WKWebsiteDataStore;

                let mtm = MainThreadMarker::new().expect("main thread");
                let store = unsafe { WKWebsiteDataStore::defaultDataStore(mtm) };
                let types = unsafe { WKWebsiteDataStore::allWebsiteDataTypes(mtm) };
                let done_tx = tx.clone();
                let handler = RcBlock::new(move || {
                    let _ = done_tx.send(Ok(()));
                });
                unsafe {
                    store.removeDataOfTypes_modifiedSince_completionHandler(
                        &types,
                        &NSDate::distantPast(),
                        &handler,
                    );
                }
            })
            .map_err(|e| e.to_string())?;
    }

    #[cfg(windows)]
    {
        // The profile is reachable only through a live webview; browse
        // tabs and the research view all share the app's profile.
        let webview = window
            .webviews()
            .into_iter()
            .find(|w| w.label().starts_with("tab-") || w.label() == RESEARCH_LABEL)
            .ok_or("Open a browse tab first, then clear browsing data.")?;
        let tx = tx.clone();
        webview
            .with_webview(move |platform| {
                use webview2_com::ClearBrowsingDataCompletedHandler;
                use webview2_com::Microsoft::Web::WebView2::Win32::{
                    ICoreWebView2Profile2, ICoreWebView2_13,
                };
                use windows::core::Interface;

                let apply = |tx: mpsc::Sender<Result<(), String>>| -> windows::core::Result<()> {
                    let core = unsafe { platform.controller().CoreWebView2() }?;
                    let core13: ICoreWebView2_13 = core.cast()?;
                    let profile: ICoreWebView2Profile2 = unsafe { core13.Profile() }?.cast()?;
                    let handler = ClearBrowsingDataCompletedHandler::create(Box::new(
                        move |error_code| {
                            let _ = tx.send(error_code.map_err(|e| e.to_string()));
                            Ok(())
                        },
                    ));
                    unsafe { profile.ClearBrowsingDataAll(&handler) }
                };
                if let Err(e) = apply(tx.clone()) {
                    let _ = tx.send(Err(e.to_string()));
                }
            })
            .map_err(|e| e.to_string())?;
    }

    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = &tx;
        return Err("Clearing browsing data is not implemented on this platform yet.".into());
    }

    #[cfg(any(target_os = "macos", windows))]
    {
        drop(tx);
        tauri::async_runtime::spawn_blocking(move || {
            rx.recv_timeout(Duration::from_secs(10))
                .map_err(|_| "Timed out clearing browsing data.".to_string())?
        })
        .await
        .map_err(|e| e.to_string())??;

        // Live webviews hold their sessions in memory; destroy them so the
        // next tab open starts from the cleared state.
        state.mru.lock().unwrap().clear();
        for webview in window.webviews() {
            let label = webview.label();
            if label.starts_with("tab-") || label == RESEARCH_LABEL {
                let _ = webview.close();
            }
        }
        Ok(())
    }
}

/// ExecuteScript returns the JS value JSON-encoded; our contract (matching
/// the WKWebView path) is the plain string the page script evaluated to.
#[cfg(windows)]
fn decode_execute_script_result(raw: &str) -> Result<String, String> {
    match serde_json::from_str::<serde_json::Value>(raw) {
        Ok(serde_json::Value::String(s)) => Ok(s),
        Ok(serde_json::Value::Null) => Ok(String::new()),
        _ => Err("Page script did not return a string.".into()),
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
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("clarity".into()),
                    }),
                ])
                .build(),
        )
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
            eval_in_tab,
            clear_browsing_data,
            open_devtools
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
