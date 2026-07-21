import { invoke } from "@tauri-apps/api/core";

/**
 * Page-extraction tools for the browse-mode AI chat (Phase 3 spike).
 *
 * Each helper evaluates JS inside the active tab's native webview via the
 * `eval_in_tab` command (WKWebView evaluateJavaScript with a completion
 * handler on macOS) and returns the string result. Injected scripts are
 * wrapped in an IIFE and must evaluate to a string.
 */

/** Cap tool results so a huge page can't blow up the prompt. */
const MAX_CHARS = 60_000;

async function evalInTab(id: string, js: string): Promise<string> {
  const out = await invoke<string>("eval_in_tab", { id, js });
  return out.length > MAX_CHARS
    ? out.slice(0, MAX_CHARS) + `\n…[truncated at ${MAX_CHARS} chars]`
    : out;
}

/** Title, URL, and basic metadata of the page. */
export function getPageMeta(id: string): Promise<string> {
  return evalInTab(
    id,
    `(() => JSON.stringify({
      title: document.title,
      url: location.href,
      description: document.querySelector('meta[name="description"]')?.content ?? null,
      lang: document.documentElement.lang || null,
    }))()`
  );
}

/**
 * Readable text content of the page (SPA-rendered included), with
 * scripts/styles/nav noise removed and whitespace collapsed.
 */
export function getPageText(id: string): Promise<string> {
  return evalInTab(
    id,
    `(() => {
      const clone = document.body.cloneNode(true);
      clone.querySelectorAll("script,style,noscript,svg,iframe").forEach((n) => n.remove());
      return clone.innerText.replace(/\\n{3,}/g, "\\n\\n").trim();
    })()`
  );
}

/** Current DOM as HTML (post-JS render), attributes and all. */
export function getPageHtml(id: string): Promise<string> {
  return evalInTab(id, `(() => document.documentElement.outerHTML)()`);
}

/** The user's current text selection in the page, if any. */
export function getSelection(id: string): Promise<string> {
  return evalInTab(id, `(() => String(getSelection()))()`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Navigate the tab to a new http(s) URL and wait for the document to be
 * ready (readyState polling via eval — good enough for a research hop).
 * Returns the landing page's meta so the model immediately knows where
 * it ended up.
 */
export async function navigateTo(id: string, url: string): Promise<string> {
  await invoke("navigate_tab", { id, url });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await sleep(500);
    try {
      const state = await invoke<string>("eval_in_tab", {
        id,
        js: `(() => document.readyState)()`,
      });
      if (state === "interactive" || state === "complete") {
        // Give SPAs a beat to render before reporting back.
        await sleep(700);
        return getPageMeta(id);
      }
    } catch {
      // Mid-navigation evals can fail; keep polling.
    }
  }
  return JSON.stringify({ warning: "Page is still loading; content may be incomplete." });
}

/** All hyperlinks on the page as JSON [{text, href}]. */
export function getPageLinks(id: string): Promise<string> {
  return evalInTab(
    id,
    `(() => JSON.stringify(
      [...document.querySelectorAll("a[href]")]
        .map((a) => ({ text: a.innerText.trim().slice(0, 120), href: a.href }))
        .filter((l) => l.text && l.href.startsWith("http"))
        .slice(0, 300)
    ))()`
  );
}
