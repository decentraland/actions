jest.mock("@actions/core", () => ({ setSecret: jest.fn(), debug: jest.fn() }));

import * as core from "@actions/core";
import { createBrokeredCredentials } from "../src/credentials";
import type { BrokerCredentials } from "../src/broker";

/**
 * The broker's session is 15 minutes — AssumeRole's floor, not a choice — and a large site
 * can outlast it. These assertions cover the refresh actually happening, and the secret
 * never reaching a log.
 */

function grant(overrides: Partial<BrokerCredentials> = {}): BrokerCredentials {
  return {
    accessKeyId: "AKIAEXAMPLE",
    secretAccessKey: "super-secret",
    sessionToken: "session-token",
    expiration: new Date(Date.now() + 900_000).toISOString(),
    ...overrides,
  };
}

describe("when building brokered credentials", () => {
  let fetchGrant: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    fetchGrant = jest.fn().mockResolvedValue(grant());
  });

  describe("and they are used for the first time", () => {
    it("should fetch a grant rather than sign with an empty key", async () => {
      const credentials = createBrokeredCredentials({ fetchGrant });

      await new Promise<void>((resolve, reject) =>
        credentials.get((err) => (err ? reject(err) : resolve())),
      );

      expect(fetchGrant).toHaveBeenCalledTimes(1);
    });

    it("should carry the access key from the grant", async () => {
      const credentials = createBrokeredCredentials({ fetchGrant });

      await new Promise<void>((resolve, reject) =>
        credentials.get((err) => (err ? reject(err) : resolve())),
      );

      expect(credentials.accessKeyId).toBe("AKIAEXAMPLE");
    });

    it("should carry the session token from the grant", async () => {
      const credentials = createBrokeredCredentials({ fetchGrant });

      await new Promise<void>((resolve, reject) =>
        credentials.get((err) => (err ? reject(err) : resolve())),
      );

      expect(credentials.sessionToken).toBe("session-token");
    });
  });

  describe("and a grant has been received", () => {
    beforeEach(async () => {
      const credentials = createBrokeredCredentials({ fetchGrant });
      await new Promise<void>((resolve, reject) =>
        credentials.get((err) => (err ? reject(err) : resolve())),
      );
    });

    it("should mask the secret access key", () => {
      expect(core.setSecret).toHaveBeenCalledWith("super-secret");
    });

    it("should mask the session token", () => {
      expect(core.setSecret).toHaveBeenCalledWith("session-token");
    });
  });

  describe("and several requests are signed concurrently", () => {
    // aws-sdk v2 coalesces concurrent refreshes internally, so the uploader's concurrency
    // of 10 must produce one broker call rather than ten.
    it("should fetch a single grant", async () => {
      const credentials = createBrokeredCredentials({ fetchGrant });

      await Promise.all(
        Array.from(
          { length: 10 },
          () =>
            new Promise<void>((resolve, reject) =>
              credentials.get((err) => (err ? reject(err) : resolve())),
            ),
        ),
      );

      expect(fetchGrant).toHaveBeenCalledTimes(1);
    });
  });

  describe("and the expiry window is checked", () => {
    // The v2 default is 15 SECONDS, which a 5 MB part plus SDK retries can outlive — the
    // request would then be signed with a key that expires in flight.
    it("should widen it well past the default", () => {
      const credentials = createBrokeredCredentials({ fetchGrant });

      expect((credentials as unknown as { expiryWindow: number }).expiryWindow).toBe(120);
    });
  });

  describe("and the broker refuses to mint a new grant", () => {
    beforeEach(() => {
      fetchGrant.mockRejectedValue(new Error("broker said no"));
    });

    it("should surface the failure rather than sign with a stale key", async () => {
      const credentials = createBrokeredCredentials({ fetchGrant });

      await expect(
        new Promise<void>((resolve, reject) =>
          credentials.get((err) => (err ? reject(err) : resolve())),
        ),
      ).rejects.toThrow("broker said no");
    });
  });

  describe("and the grant declares no expiry", () => {
    beforeEach(() => {
      fetchGrant.mockResolvedValue(grant({ expiration: undefined }));
    });

    it("should still set an expiry so the credentials refresh rather than go stale", async () => {
      const credentials = createBrokeredCredentials({ fetchGrant });

      await new Promise<void>((resolve, reject) =>
        credentials.get((err) => (err ? reject(err) : resolve())),
      );

      expect(credentials.expireTime.getTime()).toBeGreaterThan(Date.now());
    });
  });
});

describe("when a grant is close to expiring", () => {
  let fetchGrant: jest.Mock;

  const get = (credentials: ReturnType<typeof createBrokeredCredentials>) =>
    new Promise<void>((resolve, reject) =>
      credentials.get((err) => (err ? reject(err) : resolve())),
    );

  beforeEach(() => jest.clearAllMocks());

  /**
   * The whole reason this file exists. aws-sdk v2 only re-mints when it believes the
   * session has expired, so an expiry that ignores what the broker returned means a long
   * upload signs parts with a dead session and dies mid-flight on ExpiredToken.
   *
   * `expiryWindow` is 120s, so a grant with less than that left must be treated as spent.
   */
  it("should mint a new one rather than sign with a spent session", async () => {
    fetchGrant = jest
      .fn()
      .mockResolvedValue(grant({ expiration: new Date(Date.now() + 30_000).toISOString() }));
    const credentials = createBrokeredCredentials({ fetchGrant });

    await get(credentials);
    await get(credentials);

    expect(fetchGrant).toHaveBeenCalledTimes(2);
  });

  it("should reuse a grant that still has comfortable life left", async () => {
    fetchGrant = jest
      .fn()
      .mockResolvedValue(grant({ expiration: new Date(Date.now() + 900_000).toISOString() }));
    const credentials = createBrokeredCredentials({ fetchGrant });

    await get(credentials);
    await get(credentials);

    expect(fetchGrant).toHaveBeenCalledTimes(1);
  });

  // The broker always sends one, but a missing expiration must not become "never expires".
  it("should not treat a grant with no expiration as immortal", async () => {
    fetchGrant = jest.fn().mockResolvedValue(grant({ expiration: undefined }));
    const credentials = createBrokeredCredentials({ fetchGrant });

    await get(credentials);

    expect(credentials.expireTime.getTime()).toBeLessThanOrEqual(Date.now() + 900_000);
  });
});
