/** Sleep helper, injectable so tests don't actually wait. */
export type Sleep = (ms: number) => Promise<void>;

const defaultSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A transient failure worth retrying: a network error, a 429, or any 5xx. */
export function isRetryable(e: unknown): boolean {
  const status = (e as { status?: number } | undefined)?.status;
  if (typeof status === "number") return status === 429 || status >= 500;
  // No status at all means it never got a response — DNS, TLS, connection reset.
  return true;
}

/**
 * Run `fn`, retrying transient failures with exponential backoff.
 *
 * Cloudflare KV and Slack are plain HTTP calls with no client-side retry (the
 * aws-sdk already retries S3 itself). Without this a single 5xx fails the run
 * *after* the bytes are in S3, leaving the deploy half-applied: uploaded but
 * not repointed. Both operations are idempotent — a KV PUT writes the same
 * merged value, a Slack post is a duplicate message at worst — so retrying is
 * safe.
 */
export async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  opts: {
    attempts?: number;
    baseDelayMs?: number;
    sleep?: Sleep;
    onRetry?: (m: string) => void;
  } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 500;
  const sleep = opts.sleep ?? defaultSleep;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (attempt === attempts || !isRetryable(e)) throw e;
      const delay = baseDelayMs * 2 ** (attempt - 1);
      opts.onRetry?.(
        `${label} failed (attempt ${attempt}/${attempts}), retrying in ${delay}ms: ` +
          (e instanceof Error ? e.message : String(e)),
      );
      await sleep(delay);
    }
  }
  throw lastError;
}
