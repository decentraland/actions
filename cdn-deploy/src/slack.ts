import nodeFetch from "node-fetch";
import { FetchLike } from "./types";
import { withRetry, Sleep } from "./retry";

/** Carries the HTTP status so `withRetry` can tell a 429/5xx from a 4xx. */
export class SlackError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "SlackError";
  }
}

/**
 * Post the "New rollout set" message to Slack. Same block layout as
 * `webhooks-receiver`'s `changeRollout`, so the channel reads identically after
 * the migration.
 *
 * The channel is NOT set here: an incoming webhook posts to the channel chosen
 * when it was installed, and a `channel` field is ignored (only the retired
 * legacy custom integrations honoured it). Point the webhook at `rollouts`.
 *
 * `text` is the notification fallback for a blocks message — without it the
 * push and notification-pane previews render empty.
 */
export async function notifyRollout(opts: {
  webhookUrl: string;
  url: string;
  rolloutName: string;
  percentage: number;
  prefix: string;
  version: string;
  fetch?: FetchLike;
  sleep?: Sleep;
  onRetry?: (message: string) => void;
}): Promise<void> {
  const doFetch: FetchLike = opts.fetch || (nodeFetch as unknown as FetchLike);

  const body = {
    text: `New rollout set for ${opts.url}`,
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: `New rollout set for ${opts.url}` },
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", verbatim: true, text: `*Component:*\n\`${opts.rolloutName}\`` },
          { type: "mrkdwn", verbatim: true, text: `*Percentage of users:*\n${opts.percentage}%` },
          { type: "mrkdwn", verbatim: true, text: `*Package:*\n\`${opts.prefix}\`` },
          { type: "mrkdwn", verbatim: true, text: `*Version:*\n\`${opts.version}\`` },
        ],
      },
    ],
  };

  await withRetry(
    "Slack notification",
    async () => {
      const res = await doFetch(opts.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      if (!res.ok) {
        // The webhook URL is a bearer credential — keep it out of the message.
        throw new SlackError(`Slack notification failed (${res.status}): ${text}`, res.status);
      }
    },
    { sleep: opts.sleep, onRetry: opts.onRetry },
  );
}
