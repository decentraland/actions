/** Sleep helper, injectable so tests don't actually wait. */
export type Sleep = (ms: number) => Promise<void>;

const defaultSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Longest a single wait may last, so an absurd or hostile `Retry-After` cannot park a job
 * for the rest of the run's budget.
 */
export const MAX_RETRY_DELAY_MS = 30_000;

/** `Retry-After` in milliseconds, when the failure carried one the broker set. */
function retryAfterMsOf(e: unknown): number | undefined {
  const seconds = (e as { retryAfterSeconds?: number } | undefined)?.retryAfterSeconds;
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return undefined;
  return seconds * 1000;
}

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
 * The broker's endpoints are plain HTTP calls with no client-side retry (the
 * aws-sdk already retries S3 itself). Without this a single 5xx fails the run
 * *after* the bytes are in S3, leaving the deploy half-applied: uploaded but
 * not repointed. Both operations are idempotent — a KV PUT writes the same
 * merged value — so retrying is
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

      // The server's own estimate wins when it gives one. Backing off on a fixed schedule
      // instead means giving up while the thing being waited for is still in progress:
      // `rollout_in_progress` sends a Retry-After because another caller holds the lease on
      // that record, and the exponential schedule alone spends its whole budget in about a
      // second and a half. Capped so a large or malformed value cannot stall the job.
      const backoff = baseDelayMs * 2 ** (attempt - 1);
      const retryAfterMs = retryAfterMsOf(e);
      const delay = Math.min(Math.max(backoff, retryAfterMs ?? 0), MAX_RETRY_DELAY_MS);

      opts.onRetry?.(
        `${label} failed (attempt ${attempt}/${attempts}), retrying in ${delay}ms: ` +
          (e instanceof Error ? e.message : String(e)),
      );
      await sleep(delay);
    }
  }
  throw lastError;
}
