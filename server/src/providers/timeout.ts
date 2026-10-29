/** Model-call timeout helpers. Every outbound model fetch gets a timeout
 *  combined with any existing session signal. */

export const TURN_LLM_TIMEOUT_MS = 8_000;
export const SCENARIO_TIMEOUT_MS = 60_000;
export const DEBRIEF_TIMEOUT_MS = 90_000;
export const IMAGE_TIMEOUT_MS = 90_000;
export const NEWS_TTS_TIMEOUT_MS = 30_000;
export const STT_HANDSHAKE_TIMEOUT_MS = 20_000;

/** Timeout signal combined with an optional existing signal. */
export function timeoutSignal(timeoutMs: number, existing?: AbortSignal): AbortSignal {
  const ms = Math.max(1, Math.floor(timeoutMs));
  const timeout = AbortSignal.timeout(ms);
  if (!existing) return timeout;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([existing, timeout]);
  // Fallback for runtimes without AbortSignal.any.
  const ctl = new AbortController();
  const onAbort = () => ctl.abort((existing as { reason?: unknown }).reason ?? (timeout as { reason?: unknown }).reason);
  if (existing.aborted || timeout.aborted) ctl.abort();
  else {
    existing.addEventListener("abort", onAbort, { once: true });
    timeout.addEventListener("abort", onAbort, { once: true });
  }
  return ctl.signal;
}

export function isTimeoutError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: unknown; code?: unknown; message?: unknown; cause?: unknown };
  if (e.name === "TimeoutError") return true;
  if (typeof e.message === "string" && /timed?\s*out|timeout/i.test(e.message)) return true;
  if (e.cause) return isTimeoutError(e.cause);
  return false;
}

/** Network-level failures (fetch failed, socket resets) worth one retry. */
export function isNetworkError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: unknown; message?: unknown; cause?: unknown; code?: unknown };
  if (e instanceof TypeError) return true;
  if (typeof e.message === "string" && /fetch failed|network|ECONNRESET|ECONNREFUSED|ENOTFOUND|EPIPE|socket hang up|other side closed/i.test(e.message)) return true;
  if (typeof e.code === "string" && /ECONN|ENOTFOUND|EPIPE|UND_ERR/i.test(e.code)) return true;
  if (e.cause && e.cause !== err) return isNetworkError(e.cause);
  return false;
}

export function isTimeoutOrNetworkError(err: unknown): boolean {
  return isTimeoutError(err) || isNetworkError(err);
}
