import * as core from "@actions/core";
import nodeFetch from "node-fetch";
import { FetchLike } from "./types";
import { withRetry } from "./retry";

/**
 * Client for the cdn-deploy broker.
 *
 * The broker holds the Cloudflare token and the right to write the CDN bucket; this action
 * holds neither. Every call carries a GitHub OIDC token, which the broker verifies against
 * GitHub's published keys and then authorises against `@decentraland/definitions`.
 */

export type BrokerCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration?: string;
};

export type CredentialsGrant = {
  bucket: string;
  region: string;
  prefix: string;
  /** Whether a completed upload already exists for this version. */
  targetExists: boolean;
  credentials: BrokerCredentials;
  expiresInSeconds: number;
};

export type ReleaseProgress = {
  complete: boolean;
  copied: number;
  continuation?: string;
  objectCount?: number;
  prefix?: string;
};

export type RolloutResult = {
  key: string;
  environment: string;
  rolloutName: string;
  version: string;
  percentage: number;
  url: string;
};

/**
 * A failure the broker described. `code` is its stable contract — branch on that, never on
 * the message.
 */
export class BrokerError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly details: Record<string, unknown> = {},
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "BrokerError";
  }
}

export type BrokerClient = {
  requestCredentials(body: { packageName: string; version: string }): Promise<CredentialsGrant>;
  release(body: {
    packageName: string;
    version: string;
    sourceVersion: string;
    continuation?: string;
  }): Promise<ReleaseProgress>;
  rollout(body: {
    packageName: string;
    version: string;
    environment: string;
    percentage: number;
    rolloutName?: string;
  }): Promise<RolloutResult>;
};

export function createBrokerClient(opts: {
  baseUrl: string;
  audience: string;
  fetch?: FetchLike;
  /** Injected in tests; production mints a fresh token per call. */
  getToken?: () => Promise<string>;
}): BrokerClient {
  const doFetch: FetchLike = opts.fetch || (nodeFetch as unknown as FetchLike);
  // A fresh token per call on purpose: they are short-lived, and an upload long enough to
  // need a credential refresh is long enough for a cached one to have expired.
  const getToken = opts.getToken || (() => core.getIDToken(opts.audience));

  async function post<T>(path: string, body: unknown): Promise<T> {
    const token = await getToken();

    return withRetry(`broker ${path}`, async () => {
      const response = await doFetch(`${opts.baseUrl.replace(/\/+$/, "")}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });

      const text = await response.text();
      if (response.ok || response.status === 202) {
        return JSON.parse(text) as T;
      }

      let envelope: { code?: string; message?: string; details?: Record<string, unknown> } = {};
      try {
        envelope = JSON.parse(text);
      } catch {
        envelope = {};
      }
      throw new BrokerError(
        envelope.code || "broker_error",
        response.status,
        envelope.message || `The deploy broker answered ${response.status}.`,
        envelope.details || {},
        retryAfterOf(response),
      );
    });
  }

  return {
    requestCredentials: (body) => post<CredentialsGrant>("/credentials", body),
    release: (body) => post<ReleaseProgress>("/release", body),
    rollout: (body) => post<RolloutResult>("/rollout", body),
  };
}

function retryAfterOf(response: {
  headers?: { get(name: string): string | null };
}): number | undefined {
  const raw = response.headers?.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) ? seconds : undefined;
}
