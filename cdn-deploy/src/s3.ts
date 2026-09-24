import * as core from "@actions/core";
import * as AWS from "aws-sdk";
import { uploadDir } from "@dcl/cdn-uploader";
import { readConfiguration } from "@dcl/cdn-uploader/dist/utils";
import * as fs from "fs";
import * as path from "path";
import { COMPLETION_MARKER_FILENAME } from "./types";

/**
 * Upload a built folder to the CDN bucket, with credentials the broker minted for exactly
 * this version prefix.
 *
 * The client is constructed with an explicit credentials object rather than letting the
 * v2 default chain find ambient `AWS_*` variables. There is no longer an assume-role step
 * populating those, and falling back to whatever the runner happens to have would be a
 * silent path to a wider credential than the broker granted.
 *
 * Returns one entry per uploaded object — objects, not source files: the uploader writes
 * up to three per compressible file (`f`, `f.gzip`, `f.br`). The entries are the S3
 * `Location` URLs `s3.upload()` resolves with, not keys; only the count is used.
 */
export async function uploadFolderToS3(opts: {
  region: string;
  bucket: string;
  folder: string;
  remoteFolder: string;
  credentials: AWS.Credentials;
  s3?: AWS.S3;
}): Promise<string[]> {
  const s3 =
    opts.s3 ||
    new AWS.S3({ region: opts.region, credentials: opts.credentials, signatureVersion: "v4" });
  return uploadDir(s3, opts.bucket, opts.folder, opts.remoteFolder, readUploadConfig(opts.folder));
}

/** The per-site upload rules file, read from the root of the built folder. */
const CONFIG_FILE = "config.yml";

/**
 * Per-file upload rules, merged the way static-sites-pipeline merges them.
 *
 * A site can ship a `config.yml` at the root of its build declaring `contentType`,
 * `contentEncoding`, `cacheControl`, `variants` and `ignore` per glob. Ignoring it is not
 * a cosmetic loss: `ignore: true` is how a site keeps files out of a public bucket, and a
 * pre-compressed `*.wasm.br` gets no Content-Encoding or Content-Type without its rule,
 * so the browser is handed a raw brotli stream it will not decode.
 *
 * `immutable` and `concurrency` are applied LAST so a site cannot override them, which is
 * the same precedence the pipeline uses.
 */
export function readUploadConfig(folder: string): Record<string, unknown> {
  const defaults = { immutable: true, concurrency: 10 };
  const configPath = path.join(folder, CONFIG_FILE);

  if (!fs.existsSync(configPath)) return defaults;

  try {
    const config = { ...readConfiguration(configPath), ...defaults };
    core.info(`Using the upload rules from ${CONFIG_FILE}.`);
    return config as Record<string, unknown>;
  } catch (e) {
    // Deliberately fatal, unlike the pipeline, which falls back to the defaults and logs.
    // Silently dropping the rules is how a file marked `ignore` reaches a public bucket.
    throw new Error(
      `Could not read "${configPath}": ${e instanceof Error ? e.message : String(e)}. ` +
        "Fix the file or remove it — deploying without its rules would upload files it excludes " +
        "and strip the content types it sets.",
    );
  }
}

/**
 * Write the completion marker, last.
 *
 * This is what makes the prefix eligible for a rollout. The broker refuses to publish a
 * version without it, which is what stops a crashed or cancelled upload being served: any
 * "does an object exist?" check answers true as soon as the first file lands.
 */
export async function writeCompletionMarker(opts: {
  region: string;
  bucket: string;
  remoteFolder: string;
  credentials: AWS.Credentials;
  marker: {
    package: string;
    version: string;
    commit: string;
    objectCount: number;
    kind: "upload";
    completedAt: string;
    runId?: string;
  };
  s3?: AWS.S3;
}): Promise<void> {
  const s3 =
    opts.s3 ||
    new AWS.S3({ region: opts.region, credentials: opts.credentials, signatureVersion: "v4" });
  await s3
    .putObject({
      Bucket: opts.bucket,
      Key: `${opts.remoteFolder}/${COMPLETION_MARKER_FILENAME}`,
      Body: JSON.stringify(opts.marker),
      ContentType: "application/json",
      // Matches every other object the uploader writes into this public CDN prefix.
      // public-read matches every other object the uploader writes, because the bucket is
      // a public CDN origin. The cache header deliberately does NOT match: content objects
      // are immutable and cached for a year, whereas this one is read to decide whether a
      // version is publishable and must never be answered from a cache.
      ACL: "public-read",
      CacheControl: "no-cache",
    })
    .promise();
}
