import { FetchLike } from "../src/cloudflare";
import { notifyRollout } from "../src/slack";

type FetchResponse = { ok: boolean; status: number; text(): Promise<string> };

function response(status: number, body: string): FetchResponse {
  return { ok: status >= 200 && status < 300, status, text: () => Promise.resolve(body) };
}

describe("when notifying a rollout to Slack", () => {
  let fetchMock: jest.MockedFunction<FetchLike>;
  let options: Parameters<typeof notifyRollout>[0];

  beforeEach(() => {
    fetchMock = jest.fn();
    options = {
      webhookUrl: "https://hooks.example.com/services/T000/B000/xxxx",
      url: "https://decentraland.zone/auth",
      rolloutName: "_site",
      percentage: 100,
      prefix: "@dcl/auth-site",
      version: "1.0.0-42.commit-abc1234",
      fetch: fetchMock,
    };
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  describe("and the webhook accepts the message", () => {
    beforeEach(() => {
      fetchMock.mockResolvedValueOnce(response(200, "ok"));
    });

    it("should POST a rollouts-channel payload containing the version and percentage", async () => {
      await notifyRollout(options);

      const [url, init] = fetchMock.mock.calls[0];
      const body = JSON.parse((init as { body: string }).body);
      expect(url).toBe(options.webhookUrl);
      expect(body.channel).toBe("rollouts");
      expect(JSON.stringify(body)).toContain("1.0.0-42.commit-abc1234");
      expect(JSON.stringify(body)).toContain("100%");
    });
  });

  describe("and the webhook rejects the message", () => {
    beforeEach(() => {
      fetchMock.mockResolvedValueOnce(response(400, "invalid_payload"));
    });

    it("should throw including the status and body", async () => {
      await expect(notifyRollout(options)).rejects.toThrow(
        "Slack notification failed (400): invalid_payload"
      );
    });
  });
});
