import * as AWS from "aws-sdk";
import { uploadDir } from "@dcl/cdn-uploader";
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
 * Returns the uploaded object keys — objects, not source files: the uploader writes up to
 * three per compressible file (`f`, `f.gzip`, `f.br`).
 */
export async function uploadFolderToS3(opts: {
  region: string;
  bucket: string;
  folder: string;
  remoteFolder: string;
  credentials: AWS.Credentials;
  s3?: AWS.S3;
}): Promise<string[]> {
  const s3 = opts.s3 || new AWS.S3({ region: opts.region, credentials: opts.credentials });
  return uploadDir(s3, opts.bucket, opts.folder, opts.remoteFolder, {
    immutable: true,
    concurrency: 10,
  });
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
  const s3 = opts.s3 || new AWS.S3({ region: opts.region, credentials: opts.credentials });
  await s3
    .putObject({
      Bucket: opts.bucket,
      Key: `${opts.remoteFolder}/${COMPLETION_MARKER_FILENAME}`,
      Body: JSON.stringify(opts.marker),
      ContentType: "application/json",
      // Matches every other object the uploader writes into this public CDN prefix.
      ACL: "public-read",
      CacheControl: "no-cache",
    })
    .promise();
}
