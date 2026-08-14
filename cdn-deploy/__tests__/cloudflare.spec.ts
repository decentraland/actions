import {
  CloudflareKV,
  createCloudflareKV,
  FetchLike,
  patchRolloutInEnvironments,
  patchRolloutInKV,
} from "../src/cloudflare";

type FetchResponse = { ok: boolean; status: number; text(): Promise<string> };

function response(status: number, body: string): FetchResponse {
  return { ok: status >= 200 && status < 300, status, text: () => Promise.resolve(body) };
}

describe("when getting a value from the Cloudflare KV client", () => {
  let fetchMock: jest.MockedFunction<FetchLike>;
  let kv: CloudflareKV;

  beforeEach(() => {
    fetchMock = jest.fn();
    kv = createCloudflareKV({
      accountId: "acc",
      apiToken: "token",
      namespaceId: "ns",
      fetch: fetchMock,
    });
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  describe("and the key does not exist", () => {
    beforeEach(() => {
      fetchMock.mockResolvedValueOnce(response(404, "not found"));
    });

    it("should return null", async () => {
      await expect(kv.get("auth")).resolves.toBeNull();
    });
  });

  describe("and the key exists", () => {
    beforeEach(() => {
      fetchMock.mockResolvedValueOnce(response(200, '{"records":{}}'));
    });

    it("should return the raw value text", async () => {
      await expect(kv.get("auth")).resolves.toBe('{"records":{}}');
    });
  });

  describe("and the read fails with a non-404 error", () => {
    beforeEach(() => {
      fetchMock.mockResolvedValueOnce(response(500, "boom"));
    });

    it("should throw including the status and body", async () => {
      await expect(kv.get("auth")).rejects.toThrow('Cloudflare KV GET "auth" failed (500): boom');
    });
  });

  describe("and a key is requested", () => {
    beforeEach(() => {
      fetchMock.mockResolvedValueOnce(response(200, "{}"));
    });

    it("should call the values endpoint with a bearer token", async () => {
      await kv.get("auth");
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.cloudflare.com/client/v4/accounts/acc/storage/kv/namespaces/ns/values/auth",
        { headers: { authorization: "Bearer token" } }
      );
    });
  });
});

describe("when putting a value with the Cloudflare KV client", () => {
  let fetchMock: jest.MockedFunction<FetchLike>;
  let kv: CloudflareKV;

  beforeEach(() => {
    fetchMock = jest.fn();
    kv = createCloudflareKV({
      accountId: "acc",
      apiToken: "token",
      namespaceId: "ns",
      fetch: fetchMock,
    });
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  describe("and the API responds with a success envelope", () => {
    beforeEach(() => {
      fetchMock.mockResolvedValueOnce(response(200, '{"success":true,"errors":[]}'));
    });

    it("should resolve without throwing", async () => {
      await expect(kv.put("auth", "{}")).resolves.toBeUndefined();
    });
  });

  describe("and the API responds with a non-success envelope", () => {
    beforeEach(() => {
      fetchMock.mockResolvedValueOnce(
        response(200, '{"success":false,"errors":[{"message":"nope"}]}')
      );
    });

    it("should throw including the body", async () => {
      await expect(kv.put("auth", "{}")).rejects.toThrow('Cloudflare KV PUT "auth" failed');
    });
  });

  describe("and the request fails at the HTTP level", () => {
    beforeEach(() => {
      fetchMock.mockResolvedValueOnce(response(403, "forbidden"));
    });

    it("should throw including the status", async () => {
      await expect(kv.put("auth", "{}")).rejects.toThrow(
        'Cloudflare KV PUT "auth" failed (403): forbidden'
      );
    });
  });
});

describe("when patching a rollout in the KV", () => {
  let kvMock: { get: jest.Mock; put: jest.Mock };

  beforeEach(() => {
    kvMock = { get: jest.fn(), put: jest.fn().mockResolvedValue(undefined) };
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  describe("and the key has no current value", () => {
    beforeEach(() => {
      kvMock.get.mockResolvedValueOnce(null);
    });

    it("should write a record carrying the new version, percentage and prefix", async () => {
      await patchRolloutInKV(kvMock as unknown as CloudflareKV, {
        key: "auth",
        rolloutName: "_site",
        percentage: 100,
        prefix: "@dcl/auth-site",
        version: "1.0.0-42.commit-abc1234",
        timestamp: 1700000000000,
      });

      const written = JSON.parse(kvMock.put.mock.calls[0][1]);
      expect(written.records._site[0]).toMatchObject({
        version: "1.0.0-42.commit-abc1234",
        percentage: 100,
        prefix: "@dcl/auth-site",
      });
    });
  });

  describe("and the key already has a previous version", () => {
    beforeEach(() => {
      kvMock.get.mockResolvedValueOnce(
        JSON.stringify({
          records: {
            _site: [{ version: "0.9.0", percentage: 100, prefix: "@dcl/auth-site" }],
          },
        })
      );
    });

    it("should prepend the new record while keeping the previous one", async () => {
      await patchRolloutInKV(kvMock as unknown as CloudflareKV, {
        key: "auth",
        rolloutName: "_site",
        percentage: 50,
        prefix: "@dcl/auth-site",
        version: "1.0.0",
        timestamp: 1700000000000,
      });

      const written = JSON.parse(kvMock.put.mock.calls[0][1]);
      expect(written.records._site.map((r: { version: string }) => r.version)).toEqual([
        "1.0.0",
        "0.9.0",
      ]);
    });
  });
});

describe("when patching a rollout across multiple environments", () => {
  let fetchMock: jest.MockedFunction<FetchLike>;
  const targets = [
    { environment: "zone", namespaceId: "ns-zone" },
    { environment: "today", namespaceId: "ns-today" },
  ];
  const params = {
    key: "sites",
    rolloutName: "_site",
    percentage: 100,
    prefix: "@dcl/sites",
    version: "1.0.0",
    timestamp: 1700000000000,
  };

  afterEach(() => {
    jest.resetAllMocks();
  });

  describe("and every namespace accepts the write", () => {
    beforeEach(() => {
      // GET (no method) -> 404 (empty current value); PUT -> success envelope.
      fetchMock = jest.fn((_url, init) =>
        Promise.resolve(
          init?.method === "PUT" ? response(200, '{"success":true}') : response(404, "not found")
        )
      );
    });

    it("should return every environment it wrote", async () => {
      await expect(
        patchRolloutInEnvironments({ accountId: "acc", apiToken: "tok", fetch: fetchMock }, targets, params)
      ).resolves.toEqual(["zone", "today"]);
    });

    it("should PUT to each namespace's values endpoint", async () => {
      await patchRolloutInEnvironments({ accountId: "acc", apiToken: "tok", fetch: fetchMock }, targets, params);
      const putUrls = fetchMock.mock.calls
        .filter((c) => (c[1] as { method?: string } | undefined)?.method === "PUT")
        .map((c) => c[0]);
      expect(putUrls).toEqual([
        "https://api.cloudflare.com/client/v4/accounts/acc/storage/kv/namespaces/ns-zone/values/sites",
        "https://api.cloudflare.com/client/v4/accounts/acc/storage/kv/namespaces/ns-today/values/sites",
      ]);
    });
  });

  describe("and one namespace fails after another already succeeded", () => {
    beforeEach(() => {
      // zone: GET 404 then PUT ok. today: GET 404 then PUT 403 (fails).
      fetchMock = jest.fn((url, init) => {
        if (init?.method !== "PUT") return Promise.resolve(response(404, "not found"));
        return Promise.resolve(
          url.includes("ns-today") ? response(403, "forbidden") : response(200, '{"success":true}')
        );
      });
    });

    it("should attempt all envs and throw naming the failed and the already-updated ones", async () => {
      await expect(
        patchRolloutInEnvironments({ accountId: "acc", apiToken: "tok", fetch: fetchMock }, targets, params)
      ).rejects.toThrow(/failed for: today.*Already updated: zone/s);
    });
  });
});
