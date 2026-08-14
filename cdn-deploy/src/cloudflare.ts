import nodeFetch from "node-fetch";
import { patchRollouts, RolloutDomain } from "@well-known-components/rollouts-lib";

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
  }
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export type CloudflareKV = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
};

/**
 * Cloudflare KV REST client. Same endpoint shape and `Authorization: Bearer`
 * auth as `webhooks-receiver/src/adapters/cloudflare.ts`, narrowed to a single
 * namespace (the environment is resolved to a namespace id before this point).
 */
export function createCloudflareKV(opts: {
  accountId: string;
  apiToken: string;
  namespaceId: string;
  fetch?: FetchLike;
}): CloudflareKV {
  const doFetch: FetchLike = opts.fetch || (nodeFetch as unknown as FetchLike);

  // A KV key is a single opaque path segment — encodeURIComponent (not
  // encodeURI) so `/`, `.`, `?`, `#` can't alter the request path.
  const valueUrl = (key: string) =>
    `https://api.cloudflare.com/client/v4/accounts/${opts.accountId}/storage/kv/namespaces/${opts.namespaceId}/values/${encodeURIComponent(key)}`;

  return {
    async get(key) {
      const res = await doFetch(valueUrl(key), {
        headers: { authorization: `Bearer ${opts.apiToken}` },
      });
      if (res.status === 404) return null;
      if (!res.ok) {
        throw new Error(`Cloudflare KV GET "${key}" failed (${res.status}): ${await res.text()}`);
      }
      return res.text();
    },

    async put(key, value) {
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
        throw new Error(`Cloudflare KV PUT "${key}" failed (${res.status}): ${text}`);
      }
    },
  };
}

/**
 * Read-modify-write of a rollout record. Replicates `webhooks-receiver`'s
 * `changeRollout`: read the current value (absent -> empty), merge the new
 * record with `patchRollouts` (NOT hand-rolled — preserves prepend order and
 * the murmurhash bucketing the worker relies on), and write it back.
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
  }
): Promise<RolloutDomain> {
  const current = await kv.get(params.key);
  const currentValues: Partial<RolloutDomain> = current ? JSON.parse(current) : { records: {} };

  const newValues = patchRollouts(
    currentValues,
    params.rolloutName,
    { percentage: params.percentage, prefix: params.prefix, version: params.version },
    params.timestamp
  ) as RolloutDomain;

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
  account: { accountId: string; apiToken: string; fetch?: FetchLike },
  targets: { environment: string; namespaceId: string }[],
  params: {
    key: string;
    rolloutName: string;
    percentage: number;
    prefix: string;
    version: string;
    timestamp: number;
  }
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
      });
      await patchRolloutInKV(kv, params);
      succeeded.push(environment);
    } catch (e) {
      failures.push({ environment, error: e instanceof Error ? e.message : String(e) });
    }
  }

  if (failures.length) {
    const already = succeeded.length ? ` Already updated: ${succeeded.join(", ")}.` : "";
    throw new Error(
      `KV update failed for: ${failures.map((f) => f.environment).join(", ")}.${already} ` +
        `First error: ${failures[0].error}`
    );
  }
  return succeeded;
}
