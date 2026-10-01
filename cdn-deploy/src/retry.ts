/** Sleep helper, injectable so tests don't actually wait. */
export type Sleep = (ms: number) => Promise<void>;

const defaultSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Longest a single wait may last, so an absurd or hostile `Retry-After` cannot park a job
 * for the rest of the run's budget.
 */
export const MAX_RETRY_DELAY_MS = 30_000;

/**
 * Attempts allowed while another caller holds the rollout lease.
 *
 * Contention is a queue, not a fault, so the budget is sized to outlast the queue rather
 * than to give up politely. The broker answers `rollout_in_progress` with `Retry-After: 5`,
 * and the longest a lease can block a caller is the 45s after which it becomes stealable --
 * which is what a holder killed by its own 30s timeout leaves behind. Ten waits of five
 * seconds clears that. The general budget stays at three: a 5xx that has failed three times
 * is not about to stop.
 */
export const LEASE_CONTENTION_ATTEMPTS = 11;

/** Contention for the rollout lease, which is waited out rather than backed off from. */
function isLeaseContention(e: unknown): boolean {
  return (e as { code?: string } | undefined)?.code === "rollout_in_progress";
}

/**
 * `Retry-After` in milliseconds, when the failure carried one the broker set.
 *
 * Only the delta-seconds form is read. The HTTP-date form parses to NaN and is ignored,
 * leaving the backoff schedule — which is correct rather than merely tolerable, since the
 * broker only ever sends seconds.
 */
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
  // caller holds the lease on that record. It sends a Retry-After with it. Treating it as
  // terminal failed a deploy the server intended to succeed — including when the retry
  // collided with the caller's OWN first attempt after an API Gateway 504.
  //
  // A holder cannot outlive the broker's own 30s function timeout, so the wait is bounded;
  // see LEASE_CONTENTION_ATTEMPTS for why that bound sets the attempt budget.
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

  // Unbounded on purpose: the ceiling depends on which failure came back, and that is not
  // known until one does. Every path through the body either returns or throws, and `limit`
  // is finite, so this terminates.
  // Sticky: once this call has queued behind a lease it keeps the longer budget, even if a
  // later attempt comes back as something else. Recomputing from the newest error alone
  // would cut a wait short on a single 5xx arriving mid-queue, which is the one moment the
  // budget exists for.
  let contended = false;

  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      contended = contended || isLeaseContention(e);
      const limit = contended ? Math.max(attempts, LEASE_CONTENTION_ATTEMPTS) : attempts;
      if (attempt >= limit || !isRetryable(e)) throw e;

      // The server's estimate replaces the schedule rather than racing it. Backing off on
      // top of a Retry-After is counterproductive for something that is a queue rather than
      // a fault: `rollout_in_progress` means another caller holds the lease, and doubling
      // the wait each time overshoots the moment it is released. Where nothing was asked
      // for, the exponential schedule stands.
      //
      // Floored at `baseDelayMs` so an implausibly small value cannot become a hot loop,
      // and capped so a large or malformed one cannot park the job.
      const backoff = baseDelayMs * 2 ** (attempt - 1);
      const retryAfterMs = retryAfterMsOf(e);
      const delay = Math.min(Math.max(retryAfterMs ?? backoff, baseDelayMs), MAX_RETRY_DELAY_MS);

      opts.onRetry?.(
        `${label} failed (attempt ${attempt}/${limit}), retrying in ${delay}ms: ` +
          (e instanceof Error ? e.message : String(e)),
      );
      await sleep(delay);
    }
  }
}
