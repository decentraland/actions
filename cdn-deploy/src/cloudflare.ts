import nodeFetch from "node-fetch";
import { patchRollouts, RolloutDomain } from "@well-known-components/rollouts-lib";
import { withRetry, Sleep } from "./retry";

/**
 * Minimal `node-fetch` shape, narrowed to what this module needs. Kept as an
 * injectable so tests can pass a `jest.fn()` instead of hitting the network.
 */
export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export type CloudflareKV = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
};

/** Carries the HTTP status so `withRetry` can tell a 429/5xx from a 4xx. */
export class CloudflareError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "CloudflareError";
  }
}

/** Upstream bodies are untrusted and can be long; keep annotations readable. */
function truncate(text: string, max = 300): string {
  return text.length > max ? `${text.slice(0, max)}… (${text.length} bytes)` : text;
}

/**
 * Cloudflare KV REST client. Same endpoint shape and `Authorization: Bearer`
 * auth as `webhooks-receiver/src/adapters/cloudflare.ts`, narrowed to a single
 * namespace (the environment is resolved to a namespace id before this point).
 *
 * Every call is retried on a 429/5xx/network error: KV writes happen after the
 * bytes are already in S3, so a transient blip must not leave the rollout
 * half-applied.
 */
export function createCloudflareKV(opts: {
  accountId: string;
  apiToken: string;
  namespaceId: string;
  fetch?: FetchLike;
  sleep?: Sleep;
  onRetry?: (message: string) => void;
}): CloudflareKV {
  const doFetch: FetchLike = opts.fetch || (nodeFetch as unknown as FetchLike);
  const retryOpts = { sleep: opts.sleep, onRetry: opts.onRetry };

  // A KV key is a single opaque path segment — encodeURIComponent (not
  // encodeURI) so `/`, `.`, `?`, `#` can't alter the request path.
  const valueUrl = (key: string) =>
    `https://api.cloudflare.com/client/v4/accounts/${opts.accountId}/storage/kv/namespaces/${opts.namespaceId}/values/${encodeURIComponent(key)}`;

  return {
    async get(key) {
      return withRetry(
        `Cloudflare KV GET "${key}"`,
        async () => {
          const res = await doFetch(valueUrl(key), {
            headers: { authorization: `Bearer ${opts.apiToken}` },
          });
          if (res.status === 404) {
            // node-fetch does not auto-drain; leaving the body unread keeps the
            // socket pending and can delay process exit in a short-lived action.
            await res.text();
            return null;
          }
          if (!res.ok) {
            throw new CloudflareError(
              `Cloudflare KV GET "${key}" failed (${res.status}): ${truncate(await res.text())}`,
              res.status,
            );
          }
          return res.text();
        },
        retryOpts,
      );
    },

    async put(key, value) {
      return withRetry(
        `Cloudflare KV PUT "${key}"`,
        async () => {
          const res = await doFetch(valueUrl(key), {
            method: "PUT",
            headers: {
              "content-type": "text/plain",
              authorization: `Bearer ${opts.apiToken}`,
            },
            body: value,
          });
          const text = await res.text();
          // The values PUT endpoint returns a `{ success, errors, ... }` envelope.
          let envelope: { success?: boolean } | undefined;
          try {
            envelope = JSON.parse(text);
          } catch {
            envelope = undefined;
          }
          if (!res.ok || (envelope && envelope.success === false)) {
            throw new CloudflareError(
              `Cloudflare KV PUT "${key}" failed (${res.status}): ${truncate(text)}`,
              res.status,
            );
          }
        },
        retryOpts,
      );
    },
  };
}

/**
 * Parse a stored rollout value into something `patchRollouts` can merge.
 *
 * A missing key, a malformed value, or a stored `null` must not surface as a
 * context-free `SyntaxError` / `Cannot read properties of null` halfway through
 * a deploy — the message has to say which environment and key so an operator
 * can go fix it. Namespace ids are masked in the log, so the caller passes a
 * readable label rather than the id.
 */
export function parseRolloutValue(
  current: string | null,
  context: { label: string },
): Partial<RolloutDomain> {
  if (current === null || current.trim() === "") return { records: {} };

  let parsed: unknown;
  try {
    parsed = JSON.parse(current);
  } catch (e) {
    throw new Error(
      `Cloudflare KV value for "${context.label}" is not valid JSON: ` +
        `${e instanceof Error ? e.message : String(e)}`,
    );
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Cloudflare KV value for "${context.label}" is not a rollout object.`);
  }

  const domain = parsed as Partial<RolloutDomain>;
  if (
    domain.records !== undefined &&
    (typeof domain.records !== "object" || domain.records === null || Array.isArray(domain.records))
  ) {
    // An array is the dangerous shape: `patchRollouts` would assign a
    // non-index property that JSON.stringify drops, so the write would look
    // like it succeeded while silently discarding every rollout record.
    throw new Error(
      `Cloudflare KV value for "${context.label}" has a \`records\` field that is not an ` +
        "object.",
    );
  }
  return domain.records ? domain : { ...domain, records: {} };
}

/**
 * Read-modify-write of a rollout record. Replicates `webhooks-receiver`'s
 * `changeRollout`: read the current value (absent -> empty), merge the new
 * record with `patchRollouts` (NOT hand-rolled — preserves prepend order and
 * the murmurhash bucketing the worker relies on), and write it back.
 *
 * `patchRollouts` sorts the whole record array with `semver.compare`, so one
 * pre-existing non-semver version (a legacy or hand-edited entry) makes every
 * future patch throw. Its error names neither the key nor the namespace, so it
 * is re-thrown here with that context attached.
 */
export async function patchRolloutInKV(
  kv: CloudflareKV,
  params: {
    key: string;
    rolloutName: string;
    percentage: number;
    prefix: string;
    version: string;
    timestamp: number;
    /** Environment name, for error messages. Namespace ids are log-masked. */
    environment?: string;
  },
): Promise<RolloutDomain> {
  const label = params.environment ? `${params.key}" in "${params.environment}` : params.key;
  const current = await kv.get(params.key);
  const currentValues = parseRolloutValue(current, { label });

  let newValues: RolloutDomain;
  try {
    newValues = patchRollouts(
      currentValues,
      params.rolloutName,
      { percentage: params.percentage, prefix: params.prefix, version: params.version },
      params.timestamp,
    ) as RolloutDomain;
  } catch (e) {
    throw new Error(
      `Could not merge the rollout into "${label}": ` +
        `${e instanceof Error ? e.message : String(e)}. An existing record with a non-semver ` +
        "version will do this — inspect the stored value.",
    );
  }

  await kv.put(params.key, JSON.stringify(newValues));
  return newValues;
}

/**
 * Patch the same rollout record into several environments (one namespace each),
 * sharing the account + token. Used to point multiple environments at one
 * version after a single S3 upload.
 *
 * Cloudflare KV has no cross-namespace transaction, so this attempts EVERY
 * environment and, if any fail, throws an aggregate error naming which
 * environments were already updated and which failed — so a partial write
 * (e.g. zone succeeded, today failed) is visible rather than hidden behind an
 * abort on the first failure. Returns the environments successfully written.
 */
export async function patchRolloutInEnvironments(
  account: {
    accountId: string;
    apiToken: string;
    fetch?: FetchLike;
    sleep?: Sleep;
    onRetry?: (message: string) => void;
  },
  targets: { environment: string; namespaceId: string }[],
  params: {
    key: string;
    rolloutName: string;
    percentage: number;
    prefix: string;
    version: string;
    timestamp: number;
  },
): Promise<string[]> {
  const succeeded: string[] = [];
  const failures: { environment: string; error: string }[] = [];

  for (const { environment, namespaceId } of targets) {
    try {
      const kv = createCloudflareKV({
        accountId: account.accountId,
        apiToken: account.apiToken,
        namespaceId,
        fetch: account.fetch,
        sleep: account.sleep,
        onRetry: account.onRetry,
      });
      await patchRolloutInKV(kv, { ...params, environment });
      succeeded.push(environment);
    } catch (e) {
      failures.push({ environment, error: e instanceof Error ? e.message : String(e) });
    }
  }

  if (failures.length) {
    const already = succeeded.length ? ` Already updated: ${succeeded.join(", ")}.` : "";
    throw new Error(
      `KV update failed for: ${failures.map((f) => f.environment).join(", ")}.${already} ` +
        `First error: ${failures[0].error}`,
    );
  }
  return succeeded;
}
