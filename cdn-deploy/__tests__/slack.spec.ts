import { notifyRollout } from "../src/slack";

type FetchMock = jest.Mock;

const options = {
  webhookUrl: "https://hooks.slack.com/services/T000/B000/xxx",
  url: "https://decentraland.zone/auth",
  rolloutName: "_site",
  percentage: 100,
  prefix: "@dcl/auth-site",
  version: "1.0.0-42.commit-abc1234",
};

function ok(status = 200) {
  return { ok: status >= 200 && status < 300, status, text: () => Promise.resolve("ok") };
}

function failure(status: number, body = "invalid_payload") {
  return { ok: false, status, text: () => Promise.resolve(body) };
}

describe("when notifying Slack of a rollout", () => {
  let fetchMock: FetchMock;
  let sleep: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    sleep = jest.fn().mockResolvedValue(undefined);
  });

  describe("and the webhook accepts the message", () => {
    let body: {
      text: string;
      channel?: string;
      blocks: { type: string; text?: { text: string }; fields?: { text: string }[] }[];
    };

    beforeEach(async () => {
      fetchMock.mockResolvedValueOnce(ok());
      await notifyRollout({ ...options, fetch: fetchMock, sleep });
      body = JSON.parse(fetchMock.mock.calls[0][1].body);
    });

    it("should post to the webhook url", () => {
      expect(fetchMock.mock.calls[0][0]).toBe(options.webhookUrl);
    });

    it("should send a POST", () => {
      expect(fetchMock.mock.calls[0][1]).toEqual(expect.objectContaining({ method: "POST" }));
    });

    it("should send it as json", () => {
      expect(fetchMock.mock.calls[0][1].headers).toEqual(
        expect.objectContaining({ "content-type": "application/json" }),
      );
    });

    // Without a top-level `text`, the push and notification-pane previews for a
    // blocks message render empty.
    it("should carry a notification fallback", () => {
      expect(body.text).toBe(`New rollout set for ${options.url}`);
    });

    // An incoming webhook posts to the channel it was installed on and ignores
    // a `channel` field, so sending one only misleads the reader.
    it("should not try to override the channel", () => {
      expect(body).not.toHaveProperty("channel");
    });

    it("should headline the rollout target", () => {
      expect(body.blocks[0].text!.text).toBe(`New rollout set for ${options.url}`);
    });

    it("should report the component in its own field", () => {
      expect(body.blocks[1].fields![0].text).toBe("*Component:*\n`_site`");
    });

    it("should report the percentage in its own field", () => {
      expect(body.blocks[1].fields![1].text).toBe("*Percentage of users:*\n100%");
    });

    // Asserting the exact field positions, not a stringified blob: the old test
    // would have passed with the package and version values swapped.
    it("should report the package in its own field", () => {
      expect(body.blocks[1].fields![2].text).toBe("*Package:*\n`@dcl/auth-site`");
    });

    it("should report the version in its own field", () => {
      expect(body.blocks[1].fields![3].text).toBe("*Version:*\n`1.0.0-42.commit-abc1234`");
    });
  });

  describe("and the webhook rejects the payload", () => {
    beforeEach(() => {
      fetchMock.mockResolvedValueOnce(failure(400));
    });

    it("should fail with the status", async () => {
      await expect(notifyRollout({ ...options, fetch: fetchMock, sleep })).rejects.toThrow("400");
    });

    it("should not retry a client error", async () => {
      await expect(notifyRollout({ ...options, fetch: fetchMock, sleep })).rejects.toThrow();

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("and Slack is briefly unavailable", () => {
    beforeEach(() => {
      fetchMock
        .mockResolvedValueOnce(failure(503, "service unavailable"))
        .mockResolvedValueOnce(ok());
    });

    it("should retry and succeed", async () => {
      await expect(notifyRollout({ ...options, fetch: fetchMock, sleep })).resolves.toBeUndefined();
    });

    it("should have posted twice", async () => {
      await notifyRollout({ ...options, fetch: fetchMock, sleep });

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("should back off before retrying", async () => {
      await notifyRollout({ ...options, fetch: fetchMock, sleep });

      expect(sleep).toHaveBeenCalledTimes(1);
    });

    it("should report the retry", async () => {
      const onRetry = jest.fn();

      await notifyRollout({ ...options, fetch: fetchMock, sleep, onRetry });

      expect(onRetry).toHaveBeenCalledWith(expect.stringContaining("Slack notification failed"));
    });
  });

  describe("and Slack stays unavailable", () => {
    beforeEach(() => {
      fetchMock.mockResolvedValue(failure(500, "boom"));
    });

    it("should give up after the configured attempts", async () => {
      await expect(notifyRollout({ ...options, fetch: fetchMock, sleep })).rejects.toThrow("500");

      expect(fetchMock).toHaveBeenCalledTimes(3);
    });
  });
});
