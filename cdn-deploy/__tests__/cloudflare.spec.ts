import {
  CloudflareKV,
  createCloudflareKV,
  FetchLike,
  parseRolloutValue,
  patchRolloutInEnvironments,
  patchRolloutInKV,
} from "../src/cloudflare";
import { Sleep } from "../src/retry";

type FetchResponse = { ok: boolean; status: number; text: jest.Mock };

type FetchInit = { method?: string; headers?: Record<string, string>; body?: string };

type RolloutRecordJson = {
  version: string;
  percentage: number;
  prefix: string;
  createdAt?: number;
  updatedAt?: number;
};

type RolloutValueJson = { records: Record<string, RolloutRecordJson[]> };

/** Builds a fresh response whose `text()` is a spy, so draining can be asserted. */
function createResponse(status: number, body: string): FetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: jest.fn().mockResolvedValue(body),
  };
}

describe("when getting a value from the Cloudflare KV client", () => {
  let fetchMock: jest.MockedFunction<FetchLike>;
  let sleepMock: jest.MockedFunction<Sleep>;
  let onRetryMock: jest.Mock;
  let kv: CloudflareKV;
  let key: string;

  beforeEach(() => {
    fetchMock = jest.fn();
    sleepMock = jest.fn().mockResolvedValue(undefined);
    onRetryMock = jest.fn();
    key = "auth";
    kv = createCloudflareKV({
      accountId: "acc",
      apiToken: "token",
      namespaceId: "ns",
      fetch: fetchMock,
      sleep: sleepMock,
      onRetry: onRetryMock,
    });
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  describe("and the key does not exist", () => {
    let notFoundResponse: FetchResponse;

    beforeEach(() => {
      notFoundResponse = createResponse(404, "key not found");
      fetchMock.mockResolvedValueOnce(notFoundResponse);
    });

    it("should resolve to null", async () => {
      await expect(kv.get(key)).resolves.toBeNull();
    });

    it("should drain the response body so the socket is not left pending", async () => {
      await kv.get(key);

      expect(notFoundResponse.text).toHaveBeenCalledTimes(1);
    });

    it("should not retry a 404", async () => {
      await kv.get(key);

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("and the key exists", () => {
    let storedValue: string;

    beforeEach(() => {
      storedValue = '{"records":{"_site":[{"version":"1.0.0"}]}}';
      fetchMock.mockResolvedValueOnce(createResponse(200, storedValue));
    });

    it("should resolve to the raw stored body without parsing it", async () => {
      await expect(kv.get(key)).resolves.toBe(storedValue);
    });
  });

  describe("and the request is issued", () => {
    beforeEach(() => {
      fetchMock.mockResolvedValueOnce(createResponse(200, "{}"));
    });

    it("should call the namespace values endpoint for the key", async () => {
      await kv.get(key);

      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.cloudflare.com/client/v4/accounts/acc/storage/kv/namespaces/ns/values/auth",
        expect.anything(),
      );
    });

    it("should send the api token as a bearer authorization header", async () => {
      await kv.get(key);

      expect(fetchMock).toHaveBeenCalledWith(expect.any(String), {
        headers: { authorization: "Bearer token" },
      });
    });
  });

  describe("and the key contains characters that are meaningful inside a URL", () => {
    beforeEach(() => {
      key = "decentraland.zone/auth";
      fetchMock.mockResolvedValueOnce(createResponse(200, "{}"));
    });

    it("should percent-encode the key so it stays a single path segment", async () => {
      await kv.get(key);

      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.cloudflare.com/client/v4/accounts/acc/storage/kv/namespaces/ns/values/decentraland.zone%2Fauth",
        expect.anything(),
      );
    });
  });

  describe("and the read fails with a non-retryable status", () => {
    let upstreamBody: string;

    beforeEach(() => {
      upstreamBody = "x".repeat(500);
      fetchMock.mockResolvedValueOnce(createResponse(400, upstreamBody));
    });

    it("should throw an error carrying the upstream status", async () => {
      await expect(kv.get(key)).rejects.toMatchObject({
        name: "CloudflareError",
        status: 400,
      });
    });

    it("should throw naming the key and the status", async () => {
      await expect(kv.get(key)).rejects.toThrow('Cloudflare KV GET "auth" failed (400)');
    });

    it("should truncate the upstream body to 300 characters and note its real size", async () => {
      await expect(kv.get(key)).rejects.toThrow(`${"x".repeat(300)}… (500 bytes)`);
    });

    it("should not retry a 4xx that is not a 429", async () => {
      await expect(kv.get(key)).rejects.toThrow();

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("and the read fails with a 500 before succeeding", () => {
    let storedValue: string;

    beforeEach(() => {
      storedValue = '{"records":{}}';
      fetchMock.mockResolvedValueOnce(createResponse(500, "internal error"));
      fetchMock.mockResolvedValueOnce(createResponse(200, storedValue));
    });

    it("should resolve to the value returned by the retried request", async () => {
      await expect(kv.get(key)).resolves.toBe(storedValue);
    });

    it("should issue exactly one extra request", async () => {
      await kv.get(key);

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("should back off before retrying", async () => {
      await kv.get(key);

      expect(sleepMock).toHaveBeenCalledWith(500);
    });

    it("should report the retry with the attempt count and the upstream reason", async () => {
      await kv.get(key);

      expect(onRetryMock).toHaveBeenCalledWith(
        expect.stringContaining('Cloudflare KV GET "auth" failed (attempt 1/3)'),
      );
    });
  });

  describe("and the read fails with a 429 before succeeding", () => {
    beforeEach(() => {
      fetchMock.mockResolvedValueOnce(createResponse(429, "rate limited"));
      fetchMock.mockResolvedValueOnce(createResponse(200, "{}"));
    });

    it("should retry the throttled request and resolve with the value", async () => {
      await expect(kv.get(key)).resolves.toBe("{}");
    });
  });

  describe("and every attempt fails with a 500", () => {
    beforeEach(() => {
      fetchMock.mockResolvedValue(createResponse(500, "internal error"));
    });

    it("should rethrow the last failure", async () => {
      await expect(kv.get(key)).rejects.toThrow('Cloudflare KV GET "auth" failed (500)');
    });

    it("should stop after three attempts", async () => {
      await expect(kv.get(key)).rejects.toThrow();

      expect(fetchMock).toHaveBeenCalledTimes(3);
    });
  });
});

describe("when putting a value with the Cloudflare KV client", () => {
  let fetchMock: jest.MockedFunction<FetchLike>;
  let sleepMock: jest.MockedFunction<Sleep>;
  let kv: CloudflareKV;
  let key: string;
  let value: string;

  beforeEach(() => {
    fetchMock = jest.fn();
    sleepMock = jest.fn().mockResolvedValue(undefined);
    key = "auth";
    value = '{"records":{"_site":[]}}';
    kv = createCloudflareKV({
      accountId: "acc",
      apiToken: "token",
      namespaceId: "ns",
      fetch: fetchMock,
      sleep: sleepMock,
    });
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  describe("and the API accepts the write", () => {
    let sentInit: FetchInit;

    beforeEach(async () => {
      fetchMock.mockResolvedValueOnce(createResponse(200, '{"success":true,"errors":[]}'));
      await kv.put(key, value);
      sentInit = fetchMock.mock.calls[0][1] as FetchInit;
    });

    it("should use the PUT method", () => {
      expect(sentInit.method).toBe("PUT");
    });

    it("should declare the payload as plain text", () => {
      expect(sentInit.headers).toMatchObject({ "content-type": "text/plain" });
    });

    it("should send the value verbatim as the request body", () => {
      expect(sentInit.body).toBe(value);
    });

    it("should send the api token as a bearer authorization header", () => {
      expect(sentInit.headers).toMatchObject({ authorization: "Bearer token" });
    });
  });

  describe("and the API responds with a success envelope", () => {
    beforeEach(() => {
      fetchMock.mockResolvedValueOnce(createResponse(200, '{"success":true,"errors":[]}'));
    });

    it("should resolve without throwing", async () => {
      await expect(kv.put(key, value)).resolves.toBeUndefined();
    });
  });

  describe("and the API responds with a 200 carrying a failure envelope", () => {
    beforeEach(() => {
      fetchMock.mockResolvedValueOnce(
        createResponse(200, '{"success":false,"errors":[{"message":"nope"}]}'),
      );
    });

    it("should treat the write as failed and throw naming the key", async () => {
      await expect(kv.put(key, value)).rejects.toThrow('Cloudflare KV PUT "auth" failed (200)');
    });
  });

  describe("and the request fails at the HTTP level", () => {
    beforeEach(() => {
      fetchMock.mockResolvedValueOnce(createResponse(403, "forbidden"));
    });

    it("should throw an error carrying the upstream status", async () => {
      await expect(kv.put(key, value)).rejects.toMatchObject({
        name: "CloudflareError",
        status: 403,
      });
    });

    it("should throw naming the key, the status and the body", async () => {
      await expect(kv.put(key, value)).rejects.toThrow(
        'Cloudflare KV PUT "auth" failed (403): forbidden',
      );
    });
  });

  describe("and the write fails with a 500 before succeeding", () => {
    beforeEach(() => {
      fetchMock.mockResolvedValueOnce(createResponse(500, "internal error"));
      fetchMock.mockResolvedValueOnce(createResponse(200, '{"success":true}'));
    });

    it("should resolve once the retried write is accepted", async () => {
      await expect(kv.put(key, value)).resolves.toBeUndefined();
    });

    it("should back off before retrying", async () => {
      await kv.put(key, value);

      expect(sleepMock).toHaveBeenCalledWith(500);
    });
  });

  describe("and the request fails at the network level", () => {
    beforeEach(() => {
      fetchMock.mockRejectedValueOnce(new Error("ECONNRESET"));
      fetchMock.mockResolvedValueOnce(createResponse(200, '{"success":true}'));
    });

    it("should retry a response-less failure and resolve", async () => {
      await expect(kv.put(key, value)).resolves.toBeUndefined();
    });
  });
});

describe("when parsing a stored rollout value", () => {
  let context: { label: string };

  beforeEach(() => {
    context = { label: 'decentraland.zone/auth" in "zone' };
  });

  describe("and the key is absent from the namespace", () => {
    it("should seed an empty rollout domain", () => {
      expect(parseRolloutValue(null, context)).toEqual({ records: {} });
    });
  });

  describe("and the stored value is a valid rollout object", () => {
    let stored: string;

    beforeEach(() => {
      stored = JSON.stringify({
        records: { _site: [{ version: "1.0.0", percentage: 100, prefix: "@dcl/auth-site" }] },
      });
    });

    it("should return the parsed domain untouched", () => {
      expect(parseRolloutValue(stored, context)).toEqual({
        records: { _site: [{ version: "1.0.0", percentage: 100, prefix: "@dcl/auth-site" }] },
      });
    });
  });

  describe("and the stored value is a valid object without a records field", () => {
    it("should default the records to an empty object", () => {
      expect(parseRolloutValue("{}", context)).toEqual({ records: {} });
    });
  });

  describe("and the stored value is the literal string null", () => {
    it("should throw naming the key and the namespace", () => {
      expect(() => parseRolloutValue("null", context)).toThrow(
        'Cloudflare KV value for "decentraland.zone/auth" in "zone" is not a rollout object.',
      );
    });
  });

  describe("and the stored value is malformed JSON", () => {
    it("should throw naming the key and the namespace", () => {
      expect(() => parseRolloutValue("{not json", context)).toThrow(
        'Cloudflare KV value for "decentraland.zone/auth" in "zone" is not valid JSON',
      );
    });
  });

  describe("and the stored value is a JSON array", () => {
    it("should throw naming the key and the namespace", () => {
      expect(() => parseRolloutValue("[]", context)).toThrow(
        'Cloudflare KV value for "decentraland.zone/auth" in "zone" is not a rollout object.',
      );
    });
  });

  describe("and the stored records field is not an object", () => {
    it("should throw naming the key and the namespace", () => {
      expect(() => parseRolloutValue('{"records":"nope"}', context)).toThrow(
        'Cloudflare KV value for "decentraland.zone/auth" in "zone" has a `records` field that is not an object.',
      );
    });
  });

  describe("and the stored records field is null", () => {
    it("should throw naming the key and the namespace", () => {
      expect(() => parseRolloutValue('{"records":null}', context)).toThrow(
        'Cloudflare KV value for "decentraland.zone/auth" in "zone" has a `records` field that is not an object.',
      );
    });
  });

  // An array slipped through the first version of this guard: patchRollouts
  // assigns a non-index property, JSON.stringify drops it, and the PUT looks
  // like it succeeded while discarding every rollout record.
  describe("and the stored records field is an array", () => {
    it("should reject an empty array rather than silently wipe the rollout", () => {
      expect(() => parseRolloutValue('{"records":[]}', context)).toThrow(
        "`records` field that is not an object",
      );
    });

    it("should reject a populated array", () => {
      expect(() => parseRolloutValue('{"records":["x"]}', context)).toThrow(
        "`records` field that is not an object",
      );
    });
  });

  describe("and the stored value is an empty string", () => {
    it("should treat it as absent rather than as corrupt JSON", () => {
      expect(parseRolloutValue("", context)).toEqual({ records: {} });
    });

    it("should treat whitespace as absent too", () => {
      expect(parseRolloutValue("   ", context)).toEqual({ records: {} });
    });
  });
});

describe("when patching a rollout in the KV", () => {
  let kvMock: { get: jest.Mock; put: jest.Mock };
  let kv: CloudflareKV;
  let timestamp: number;

  beforeEach(() => {
    kvMock = { get: jest.fn(), put: jest.fn().mockResolvedValue(undefined) };
    kv = kvMock as unknown as CloudflareKV;
    timestamp = 1700000000000;
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  describe("and the key has no current value", () => {
    let written: RolloutValueJson;

    beforeEach(async () => {
      kvMock.get.mockResolvedValueOnce(null);
      await patchRolloutInKV(kv, {
        key: "auth",
        rolloutName: "_site",
        percentage: 100,
        prefix: "@dcl/auth-site",
        version: "1.0.0-42.commit-abc1234",
        timestamp,
        environment: "zone",
      });
      written = JSON.parse(kvMock.put.mock.calls[0][1] as string);
    });

    it("should read the key before writing it", () => {
      expect(kvMock.get).toHaveBeenCalledWith("auth");
    });

    it("should seed an empty domain and write the single new record", () => {
      expect(written.records._site).toEqual([
        expect.objectContaining({
          version: "1.0.0-42.commit-abc1234",
          percentage: 100,
          prefix: "@dcl/auth-site",
        }),
      ]);
    });

    it("should write the merged value back under the same key", () => {
      expect(kvMock.put).toHaveBeenCalledWith("auth", expect.any(String));
    });
  });

  describe("and the key already holds an older version", () => {
    let written: RolloutValueJson;

    beforeEach(async () => {
      kvMock.get.mockResolvedValueOnce(
        JSON.stringify({
          records: { _site: [{ version: "0.9.0", percentage: 100, prefix: "@dcl/auth-site" }] },
        }),
      );
      await patchRolloutInKV(kv, {
        key: "auth",
        rolloutName: "_site",
        percentage: 50,
        prefix: "@dcl/auth-site",
        version: "1.0.0",
        timestamp,
        environment: "zone",
      });
      written = JSON.parse(kvMock.put.mock.calls[0][1] as string);
    });

    it("should keep the previous record and put the newer version first", () => {
      expect(written.records._site.map((record) => record.version)).toEqual(["1.0.0", "0.9.0"]);
    });
  });

  describe("and the same version is patched again", () => {
    let written: RolloutValueJson;

    beforeEach(async () => {
      kvMock.get.mockResolvedValueOnce(
        JSON.stringify({
          records: {
            _site: [
              {
                version: "1.0.0",
                percentage: 10,
                prefix: "@dcl/auth-site",
                createdAt: 1600000000000,
                updatedAt: 1600000000000,
              },
            ],
          },
        }),
      );
      await patchRolloutInKV(kv, {
        key: "auth",
        rolloutName: "_site",
        percentage: 100,
        prefix: "@dcl/auth-site",
        version: "1.0.0",
        timestamp,
        environment: "zone",
      });
      written = JSON.parse(kvMock.put.mock.calls[0][1] as string);
    });

    it("should not append a duplicate record for the version already stored", () => {
      expect(written.records._site).toHaveLength(1);
    });

    it("should refresh the updatedAt of the existing record", () => {
      expect(written.records._site[0].updatedAt).toBe(timestamp);
    });

    it("should keep the original createdAt of the existing record", () => {
      expect(written.records._site[0].createdAt).toBe(1600000000000);
    });

    it("should apply the new percentage to the existing record", () => {
      expect(written.records._site[0].percentage).toBe(100);
    });
  });

  describe("and the stored value holds a record with a non-semver version", () => {
    beforeEach(() => {
      kvMock.get.mockResolvedValueOnce(
        JSON.stringify({
          records: { _site: [{ version: "latest", percentage: 100, prefix: "p" }] },
        }),
      );
    });

    it("should throw naming the key and the namespace", async () => {
      await expect(
        patchRolloutInKV(kv, {
          key: "auth",
          rolloutName: "_site",
          percentage: 100,
          prefix: "@dcl/auth-site",
          version: "1.0.0",
          timestamp,
          environment: "zone",
        }),
      ).rejects.toThrow('Could not merge the rollout into "auth" in "zone"');
    });

    it("should not write anything back to the KV", async () => {
      await expect(
        patchRolloutInKV(kv, {
          key: "auth",
          rolloutName: "_site",
          percentage: 100,
          prefix: "@dcl/auth-site",
          version: "1.0.0",
          timestamp,
          environment: "zone",
        }),
      ).rejects.toThrow();

      expect(kvMock.put).not.toHaveBeenCalled();
    });
  });

  describe("and the stored value is malformed", () => {
    beforeEach(() => {
      kvMock.get.mockResolvedValueOnce("{not json");
    });

    it("should throw naming the key and the namespace", async () => {
      await expect(
        patchRolloutInKV(kv, {
          key: "auth",
          rolloutName: "_site",
          percentage: 100,
          prefix: "@dcl/auth-site",
          version: "1.0.0",
          timestamp,
          environment: "zone",
        }),
      ).rejects.toThrow('Cloudflare KV value for "auth" in "zone" is not valid JSON');
    });
  });
});

describe("when patching a rollout across multiple environments", () => {
  let fetchMock: jest.MockedFunction<FetchLike>;
  let sleepMock: jest.MockedFunction<Sleep>;
  let account: {
    accountId: string;
    apiToken: string;
    fetch: FetchLike;
    sleep: Sleep;
  };
  let targets: { environment: string; namespaceId: string }[];
  let params: {
    key: string;
    rolloutName: string;
    percentage: number;
    prefix: string;
    version: string;
    timestamp: number;
  };

  beforeEach(() => {
    fetchMock = jest.fn();
    sleepMock = jest.fn().mockResolvedValue(undefined);
    account = { accountId: "acc", apiToken: "tok", fetch: fetchMock, sleep: sleepMock };
    targets = [
      { environment: "zone", namespaceId: "ns-zone" },
      { environment: "today", namespaceId: "ns-today" },
    ];
    params = {
      key: "sites",
      rolloutName: "_site",
      percentage: 100,
      prefix: "@dcl/sites",
      version: "1.0.0",
      timestamp: 1700000000000,
    };
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  describe("and every namespace accepts the write", () => {
    beforeEach(() => {
      fetchMock.mockImplementation((_url, init) =>
        Promise.resolve(
          init?.method === "PUT"
            ? createResponse(200, '{"success":true}')
            : createResponse(404, "key not found"),
        ),
      );
    });

    it("should return every environment it wrote, in order", async () => {
      await expect(patchRolloutInEnvironments(account, targets, params)).resolves.toEqual([
        "zone",
        "today",
      ]);
    });

    it("should write to each environment's own namespace endpoint in order", async () => {
      await patchRolloutInEnvironments(account, targets, params);

      expect(
        fetchMock.mock.calls
          .filter((call) => (call[1] as FetchInit | undefined)?.method === "PUT")
          .map((call) => call[0]),
      ).toEqual([
        "https://api.cloudflare.com/client/v4/accounts/acc/storage/kv/namespaces/ns-zone/values/sites",
        "https://api.cloudflare.com/client/v4/accounts/acc/storage/kv/namespaces/ns-today/values/sites",
      ]);
    });
  });

  // The "nothing was written" arm of the aggregate message had never been
  // produced — and it is what an operator sees with a bad API token.
  describe("and every namespace fails", () => {
    beforeEach(() => {
      fetchMock.mockImplementation((url, init) => {
        if (init?.method !== "PUT") return Promise.resolve(createResponse(404, "key not found"));
        return Promise.resolve(createResponse(403, "forbidden"));
      });
    });

    it("should throw naming every failed environment", async () => {
      await expect(patchRolloutInEnvironments(account, targets, params)).rejects.toThrow(
        "KV update failed for: zone, today.",
      );
    });

    it("should not claim anything was already updated", async () => {
      await expect(patchRolloutInEnvironments(account, targets, params)).rejects.toThrow(
        expect.objectContaining({
          message: expect.not.stringContaining("Already updated"),
        }) as unknown as Error,
      );
    });
  });

  describe("and one namespace fails after another already succeeded", () => {
    beforeEach(() => {
      fetchMock.mockImplementation((url, init) => {
        if (init?.method !== "PUT") return Promise.resolve(createResponse(404, "key not found"));
        return Promise.resolve(
          url.includes("ns-today")
            ? createResponse(403, "forbidden")
            : createResponse(200, '{"success":true}'),
        );
      });
    });

    it("should throw naming the environments that failed", async () => {
      await expect(patchRolloutInEnvironments(account, targets, params)).rejects.toThrow(
        "KV update failed for: today.",
      );
    });

    it("should throw naming the environments that were already updated", async () => {
      await expect(patchRolloutInEnvironments(account, targets, params)).rejects.toThrow(
        "Already updated: zone.",
      );
    });

    it("should still attempt the failing environment instead of aborting on the first error", async () => {
      await expect(patchRolloutInEnvironments(account, targets, params)).rejects.toThrow();

      expect(
        fetchMock.mock.calls.filter((call) => (call[1] as FetchInit | undefined)?.method === "PUT"),
      ).toHaveLength(2);
    });
  });

  describe("and the first namespace fails before the rest succeed", () => {
    beforeEach(() => {
      fetchMock.mockImplementation((url, init) => {
        if (init?.method !== "PUT") return Promise.resolve(createResponse(404, "key not found"));
        return Promise.resolve(
          url.includes("ns-zone")
            ? createResponse(403, "forbidden")
            : createResponse(200, '{"success":true}'),
        );
      });
    });

    // Every environment is attempted, so a later success after an early
    // failure is real and must be reported — that partial state is exactly
    // what an operator needs to see.
    it("should name the environment that failed", async () => {
      await expect(patchRolloutInEnvironments(account, targets, params)).rejects.toThrow(
        "KV update failed for: zone",
      );
    });

    it("should still report the environment that was already updated", async () => {
      await expect(patchRolloutInEnvironments(account, targets, params)).rejects.toThrow(
        "Already updated: today",
      );
    });
  });

  describe("and a namespace holds a value that cannot be parsed", () => {
    beforeEach(() => {
      fetchMock.mockImplementation((url, init) => {
        if (init?.method === "PUT") return Promise.resolve(createResponse(200, '{"success":true}'));
        return Promise.resolve(
          url.includes("ns-today")
            ? createResponse(200, "{not json")
            : createResponse(404, "key not found"),
        );
      });
    });

    it("should surface the failing namespace id in the aggregate error", async () => {
      await expect(patchRolloutInEnvironments(account, targets, params)).rejects.toThrow(
        'Cloudflare KV value for "sites" in "today" is not valid JSON',
      );
    });
  });
});
