import nodeFetch from "node-fetch";
import { FetchLike } from "./cloudflare";

/**
 * Post the "New rollout set" message to the `rollouts` Slack channel. Same
 * block layout as `webhooks-receiver`'s `changeRollout`, so the channel reads
 * identically after the migration.
 */
export async function notifyRollout(opts: {
  webhookUrl: string;
  url: string;
  rolloutName: string;
  percentage: number;
  prefix: string;
  version: string;
  fetch?: FetchLike;
}): Promise<void> {
  const doFetch: FetchLike = opts.fetch || (nodeFetch as unknown as FetchLike);

  const body = {
    channel: "rollouts",
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

  const res = await doFetch(opts.webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Slack notification failed (${res.status}): ${await res.text()}`);
  }
}
