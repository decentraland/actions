/** Sleep helper, injectable so tests don't actually wait. */
export type Sleep = (ms: number) => Promise<void>;

const defaultSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A transient failure worth retrying: a network error, a 429, or any 5xx. */
export function isRetryable(e: unknown): boolean {
  // A bug in the callback is not a transient failure: retrying it just repeats
  // the same stack trace and buries the real cause under "retrying" warnings.
  if (e instanceof TypeError || e instanceof ReferenceError || e instanceof SyntaxError) {
    return false;
  }
  // `rollout_in_progress` is a 409, but the broker means it as "wait", not "no": another
  // rollout holds the lease on that key and will finish in well under a second. It even
  // sends Retry-After. Treating it as terminal failed a deploy the server intended to
  // succeed — including when the retry collided with the caller's OWN first attempt after
  // an API Gateway 504.
  const code = (e as { code?: string } | undefined)?.code;
  if (code === "rollout_in_progress") return true;

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
  const attempts = Math.max(1, opts.attempts ?? 3);
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
