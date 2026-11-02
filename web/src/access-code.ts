/** Access-code gate (Brief 19). Stored in localStorage, never logged. */

const STORAGE_KEY = "hot-seat-access-code";

export function getAccessCode(): string {
  try {
    return window.localStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setAccessCode(code: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, code);
  } catch {
    /* storage unavailable: the code lives for this page load only */
  }
}

/**
 * Accept `?code=XXXX` in the page URL once: store it and strip it from the
 * address bar so a judge link can carry the code. Returns the code, if any.
 */
export function takeCodeFromUrl(): string | null {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  if (!code) return null;
  setAccessCode(code);
  params.delete("code");
  const rest = params.toString();
  const url = window.location.pathname + (rest ? `?${rest}` : "") + window.location.hash;
  window.history.replaceState(null, "", url);
  return code;
}

/** Headers for fetch() API calls. Adds x-access-code when one is stored. */
export function apiHeaders(extra?: HeadersInit): HeadersInit {
  const code = getAccessCode();
  if (!code) return { ...extra };
  return { ...extra, "x-access-code": code };
}

/** Same-origin fetch with the access-code header. */
export function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return fetch(input, { ...init, headers: apiHeaders(init?.headers) });
}

/**
 * Append `?code=` to a same-origin media URL (<audio> and <img> cannot set
 * headers). Returns the URL unchanged when no code is stored.
 */
export function withCode(url: string | null | undefined): string | null | undefined {
  if (!url) return url;
  const code = getAccessCode();
  if (!code) return url;
  return url + (url.includes("?") ? "&" : "?") + `code=${encodeURIComponent(code)}`;
}

/** /ws URL for the session socket, carrying the code when one is stored. */
export function wsUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const code = getAccessCode();
  return `${proto}//${window.location.host}/ws${code ? `?code=${encodeURIComponent(code)}` : ""}`;
}
