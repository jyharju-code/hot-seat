/** Access-code gate (Brief 19). The code is never logged. */

/** Header the browser sends on every API request. */
export const ACCESS_CODE_HEADER = "x-access-code";

/**
 * True when the request carries the configured code. When no code is
 * configured, everything is allowed (local dev, sims).
 */
export function isAccessAllowed(provided: string | null | undefined, expected: string | undefined): boolean {
  if (!expected) return true;
  return typeof provided === "string" && provided.length > 0 && provided === expected;
}

/** Pull `?code=` from a request URL such as `/ws?code=XXXX`. Never logged. */
export function wsCodeFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  const query = url.indexOf("?");
  if (query < 0) return null;
  const params = new URLSearchParams(url.slice(query + 1));
  const code = params.get("code");
  return code && code.length > 0 ? code : null;
}

/**
 * Code for an HTTP API request: the `x-access-code` header first, then
 * `?code=` (media elements cannot set headers). Never logged.
 */
export function httpCodeFromRequest(
  header: string | string[] | undefined,
  url: string | undefined,
): string | null {
  const first = Array.isArray(header) ? header[0] : header;
  if (typeof first === "string" && first.length > 0) return first;
  return wsCodeFromUrl(url);
}

/**
 * Decide a `/ws` upgrade purely from the request URL and config. The caller
 * destroys the socket when this returns false.
 */
export function isWsUpgradeAllowed(url: string | undefined, accessCode: string | undefined): boolean {
  return isAccessAllowed(wsCodeFromUrl(url), accessCode);
}
