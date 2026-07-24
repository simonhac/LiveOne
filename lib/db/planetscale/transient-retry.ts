export interface TransientPostgresRetryOptions {
  /** Total attempts for one atomic or idempotent operation. */
  maxAttempts?: number;
  /** Initial retry delay; subsequent delays use linear backoff. */
  retryDelayMs?: number;
  /** Test seam; production defaults to a real timer. */
  sleep?: (delayMs: number) => Promise<void>;
}

const TRANSIENT_CONNECTION_CODES = new Set([
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "ENETRESET",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now
]);

/** Whether retrying a complete atomic/idempotent operation is appropriate. */
export function isTransientPostgresError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    code?: unknown;
    message?: unknown;
    cause?: unknown;
  };
  const code = typeof candidate.code === "string" ? candidate.code : "";
  if (code.startsWith("08") || TRANSIENT_CONNECTION_CODES.has(code))
    return true;
  const message =
    typeof candidate.message === "string"
      ? candidate.message.toLowerCase()
      : "";
  if (
    message.includes("connection terminated") ||
    message.includes("connection reset") ||
    message.includes("client has encountered a connection error") ||
    message.includes("socket hang up") ||
    message.includes("broken pipe")
  ) {
    return true;
  }
  return candidate.cause ? isTransientPostgresError(candidate.cause) : false;
}

export async function withTransientPostgresRetry<T>(
  operation: () => Promise<T>,
  options: TransientPostgresRetryOptions = {},
  onRetry: (error: unknown, nextAttempt: number, delayMs: number) => void = (
    error,
    nextAttempt,
    delayMs,
  ) => {
    console.warn(
      `[Postgres] transient connection failure; retrying attempt ${nextAttempt} in ${delayMs}ms:`,
      error,
    );
  },
): Promise<T> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? 500);
  const sleep =
    options.sleep ??
    ((delayMs: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, delayMs)));

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= maxAttempts || !isTransientPostgresError(error)) {
        throw error;
      }
      const delayMs = retryDelayMs * attempt;
      onRetry(error, attempt + 1, delayMs);
      await sleep(delayMs);
    }
  }
}
