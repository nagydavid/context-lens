const TRANSIENT_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "UND_ERR_SOCKET",
]);

const TRANSIENT_MESSAGE =
  /fetch failed|network|socket hang up|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|\b50[234]\b|bad gateway|service unavailable|gateway timeout/i;

function matches(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return typeof error === "string" && TRANSIENT_MESSAGE.test(error);
  }
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (typeof code === "string" && TRANSIENT_CODES.has(code)) return true;
  return typeof message === "string" && TRANSIENT_MESSAGE.test(message);
}

/**
 * Best-effort heuristic: does this error look like a transient network failure
 * worth retrying? Timeouts and subagent spawn failures are never transient.
 */
export function isTransientError(error: unknown): boolean {
  if (typeof error === "object" && error !== null) {
    const { name, message } = error as { name?: unknown; message?: unknown };
    if (name === "TimeoutError") return false;
    if (typeof message === "string" && message.startsWith("subagent spawn failed")) {
      return false;
    }
  }
  if (matches(error)) return true;
  const cause = typeof error === "object" && error !== null ? (error as { cause?: unknown }).cause : undefined;
  return cause !== undefined && matches(cause);
}
