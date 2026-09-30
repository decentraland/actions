import * as AWS from "aws-sdk";
import * as core from "@actions/core";
import { BrokerCredentials } from "./broker";

/**
 * An aws-sdk v2 credentials object backed by the deploy broker.
 *
 * The broker's session lasts 15 minutes — that is `AssumeRole`'s floor, not a policy
 * choice — and a large site can take longer than that to upload. Refreshing beats failing:
 * every part of a multipart upload is signed separately, so swapping the key mid-upload is
 * transparent, whereas a hard "your upload exceeded 15 minutes" would make the action
 * unusable for exactly the sites that need it most.
 *
 * v2 calls `get()` before signing every request. Concurrent refreshes are NOT coalesced by
 * `get()` — that is opt-in, via `coalesceRefresh`, which queues the callbacks and invokes
 * `load` once. So the work goes in `load` and `refresh` delegates; otherwise the uploader's
 * concurrency of 10 would mint ten sessions instead of one.
 */
export function createBrokeredCredentials(opts: {
  fetchGrant: () => Promise<BrokerCredentials>;
  onRefresh?: (expiresAt: Date | undefined) => void;
}): AWS.Credentials {
  const credentials = new AWS.Credentials({ accessKeyId: "", secretAccessKey: "" });

  // The default is 15 SECONDS. A 5 MB part on a slow runner, plus the SDK's own retries,
  // can outlive that — and the request would then be signed with a key that expires while
  // it is in flight.
  //
  // Cast because aws-sdk v2 declares `expiryWindow` only as a static, while `needsRefresh`
  // reads `this.expiryWindow` off the instance (lib/credentials.js sets it per object).
  // The gap is in the typings, not the behaviour.
  (credentials as unknown as { expiryWindow: number }).expiryWindow = 120;

  // `load` does the work and `refresh` routes through `coalesceRefresh`, which is what
  // makes ten concurrent signers share one broker call. Both are `@api private` in the v2
  // typings, hence the casts.
  const internals = credentials as unknown as {
    load: (callback: (err?: AWS.AWSError) => void) => void;
    refresh: (callback: (err?: AWS.AWSError) => void) => void;
    coalesceRefresh: (callback: (err?: AWS.AWSError) => void, sync?: boolean) => void;
  };

  internals.load = (callback) => {
    opts
      .fetchGrant()
      .then((grant) => {
        // Masked before anything else can log them.
        core.setSecret(grant.secretAccessKey);
        core.setSecret(grant.sessionToken);

        credentials.accessKeyId = grant.accessKeyId;
        credentials.secretAccessKey = grant.secretAccessKey;
        credentials.sessionToken = grant.sessionToken;
        credentials.expireTime = grant.expiration
          ? new Date(grant.expiration)
          : new Date(Date.now() + 900_000);
        opts.onRefresh?.(credentials.expireTime);
        callback();
      })
      .catch((error) => callback(error as AWS.AWSError));
  };

  internals.refresh = (callback) => internals.coalesceRefresh(callback);

  // Forces the first `get()` to fetch rather than sign with the empty placeholder.
  credentials.expired = true;
  return credentials;
}
