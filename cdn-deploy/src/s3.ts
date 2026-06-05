import * as AWS from "aws-sdk";
import { uploadDir } from "@dcl/cdn-uploader";

/**
 * Upload a built folder to the CDN bucket under `<remoteFolder>` using
 * `@dcl/cdn-uploader`'s `uploadDir` with the same `{ immutable, concurrency }`
 * config as `static-sites-pipeline`.
 *
 * The `AWS.S3` client is constructed with NO explicit credentials on purpose:
 * the aws-sdk v2 default credential provider chain reads the env vars set by
 * `aws-actions/configure-aws-credentials` (`AWS_ACCESS_KEY_ID`,
 * `AWS_SECRET_ACCESS_KEY` and crucially `AWS_SESSION_TOKEN` for OIDC temp
 * creds). Passing partial explicit creds would bypass the session token.
 */
export async function uploadFolderToS3(opts: {
  region: string;
  bucket: string;
  folder: string;
  remoteFolder: string;
  dryRun?: boolean;
  s3?: AWS.S3;
}): Promise<string[]> {
  const s3 = opts.s3 || new AWS.S3({ region: opts.region });
  return uploadDir(s3, opts.bucket, opts.folder, opts.remoteFolder, {
    immutable: true,
    concurrency: 10,
    dryRun: opts.dryRun,
  });
}
