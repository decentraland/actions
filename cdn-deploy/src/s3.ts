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

/** Strip trailing slashes and append a single one. */
function asPrefix(folder: string): string {
  return folder.replace(/\/+$/, "") + "/";
}

/**
 * Does an S3 object exist? Used as the "is this version already deployed?"
 * signal (we check `<dir>/index.html`). A 404 / NotFound maps to `false`; other
 * errors (auth, network) propagate so we don't silently treat them as "absent".
 */
export async function objectExists(opts: {
  region: string;
  bucket: string;
  key: string;
  s3?: AWS.S3;
}): Promise<boolean> {
  const s3 = opts.s3 || new AWS.S3({ region: opts.region });
  try {
    await s3.headObject({ Bucket: opts.bucket, Key: opts.key }).promise();
    return true;
  } catch (e) {
    const err = e as { statusCode?: number; code?: string };
    if (err && (err.statusCode === 404 || err.code === "NotFound" || err.code === "NoSuchKey")) {
      return false;
    }
    throw e;
  }
}

/**
 * Server-side copy of every object under `sourceFolder/` to `targetFolder/`
 * within the same bucket — the no-rebuild redeploy.
 *
 * `@dcl/cdn-uploader` writes each compressible file as separate objects
 * (`file`, `file.gzip`, `file.br`) with `public-read` ACL and per-object
 * content metadata. Copying every object under the prefix with
 * `MetadataDirective: "COPY"` (preserves ContentType / ContentEncoding /
 * CacheControl / ContentDisposition) and `ACL: "public-read"` (copies do NOT
 * carry the source ACL) reproduces exactly what a fresh upload would serve.
 */
export async function copyFolderInS3(opts: {
  region: string;
  bucket: string;
  sourceFolder: string;
  targetFolder: string;
  concurrency?: number;
  s3?: AWS.S3;
}): Promise<number> {
  const s3 = opts.s3 || new AWS.S3({ region: opts.region });
  const srcPrefix = asPrefix(opts.sourceFolder);
  const dstPrefix = asPrefix(opts.targetFolder);
  const concurrency = opts.concurrency || 16;

  let continuationToken: string | undefined;
  let copied = 0;

  do {
    const listed = await s3
      .listObjectsV2({
        Bucket: opts.bucket,
        Prefix: srcPrefix,
        ContinuationToken: continuationToken,
      })
      .promise();

    const keys = (listed.Contents || []).map((o) => o.Key).filter((k): k is string => !!k);

    for (let i = 0; i < keys.length; i += concurrency) {
      const batch = keys.slice(i, i + concurrency);
      await Promise.all(
        batch.map((sourceKey) => {
          const targetKey = dstPrefix + sourceKey.slice(srcPrefix.length);
          // CopySource must be `/<bucket>/<key>` with each path segment encoded
          // (encodeURIComponent on the whole key would clobber the slashes).
          const copySource = `/${opts.bucket}/${sourceKey.split("/").map(encodeURIComponent).join("/")}`;
          return s3
            .copyObject({
              Bucket: opts.bucket,
              CopySource: copySource,
              Key: targetKey,
              MetadataDirective: "COPY",
              ACL: "public-read",
            })
            .promise();
        })
      );
      copied += batch.length;
    }

    continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (continuationToken);

  if (copied === 0) {
    throw new Error(`No objects found under s3://${opts.bucket}/${srcPrefix} to copy.`);
  }
  return copied;
}
