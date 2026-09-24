const mockUploadDir = jest.fn();

jest.mock("@dcl/cdn-uploader", () => ({ uploadDir: mockUploadDir }));

import * as AWS from "aws-sdk";
import { uploadFolderToS3, writeCompletionMarker } from "../src/s3";

type S3Mock = { putObject: jest.Mock };

function fakeCredentials(): AWS.Credentials {
  return new AWS.Credentials({ accessKeyId: "AKIA", secretAccessKey: "secret" });
}

describe("when uploading a folder to S3", () => {
  let s3: S3Mock;
  let credentials: AWS.Credentials;

  beforeEach(() => {
    mockUploadDir.mockReset();
    mockUploadDir.mockResolvedValueOnce(["index.html", "index.html.gzip"]);
    s3 = { putObject: jest.fn() };
    credentials = fakeCredentials();
  });

  it("should pass the bucket, folder and remote folder through to the uploader", async () => {
    await uploadFolderToS3({
      region: "us-east-1",
      bucket: "cdn-bucket",
      folder: "./dist",
      remoteFolder: "@dcl/auth-site/1.0.0-commit-abc1234",
      credentials,
      s3: s3 as never,
    });

    expect(mockUploadDir).toHaveBeenCalledWith(
      s3,
      "cdn-bucket",
      "./dist",
      "@dcl/auth-site/1.0.0-commit-abc1234",
      expect.anything(),
    );
  });

  it("should upload immutably with a concurrency of 10, matching static-sites-pipeline", async () => {
    await uploadFolderToS3({
      region: "us-east-1",
      bucket: "cdn-bucket",
      folder: "./dist",
      remoteFolder: "pkg/1.0.0",
      credentials,
      s3: s3 as never,
    });

    expect(mockUploadDir).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      // dryRun and skipRepeated are pinned too: uploadDir honours them, and a site
      // setting either uploads nothing while the run still looks successful.
      expect.objectContaining({
        immutable: true,
        concurrency: 10,
        dryRun: false,
        skipRepeated: false,
      }),
    );
  });

  it("should resolve to the uploaded object keys", async () => {
    await expect(
      uploadFolderToS3({
        region: "us-east-1",
        bucket: "cdn-bucket",
        folder: "./dist",
        remoteFolder: "pkg/1.0.0",
        credentials,
        s3: s3 as never,
      }),
    ).resolves.toEqual(["index.html", "index.html.gzip"]);
  });
});

describe("when writing the completion marker", () => {
  let s3: S3Mock;
  let credentials: AWS.Credentials;
  const marker = {
    package: "@dcl/auth-site",
    version: "1.0.0-commit-abc1234",
    commit: "abc1234",
    objectCount: 42,
    kind: "upload" as const,
    completedAt: "2026-09-24T00:00:00.000Z",
    runId: "99",
  };

  beforeEach(() => {
    s3 = { putObject: jest.fn().mockReturnValue({ promise: () => Promise.resolve({}) }) };
    credentials = fakeCredentials();
  });

  // The broker refuses to roll out a prefix without this object, which is what stops a
  // crashed upload being published.
  it("should write it inside the version prefix", async () => {
    await writeCompletionMarker({
      region: "us-east-1",
      bucket: "cdn-bucket",
      remoteFolder: "@dcl/auth-site/1.0.0-commit-abc1234",
      credentials,
      marker,
      s3: s3 as never,
    });

    expect(s3.putObject).toHaveBeenCalledWith(
      expect.objectContaining({
        Bucket: "cdn-bucket",
        Key: "@dcl/auth-site/1.0.0-commit-abc1234/.deploy-complete.json",
      }),
    );
  });

  it("should record what was uploaded", async () => {
    await writeCompletionMarker({
      region: "us-east-1",
      bucket: "cdn-bucket",
      remoteFolder: "pkg/1.0.0",
      credentials,
      marker,
      s3: s3 as never,
    });

    expect(JSON.parse(s3.putObject.mock.calls[0][0].Body)).toEqual(marker);
  });

  // Matches every other object the uploader writes into this public CDN prefix.
  it("should make it publicly readable", async () => {
    await writeCompletionMarker({
      region: "us-east-1",
      bucket: "cdn-bucket",
      remoteFolder: "pkg/1.0.0",
      credentials,
      marker,
      s3: s3 as never,
    });

    expect(s3.putObject).toHaveBeenCalledWith(expect.objectContaining({ ACL: "public-read" }));
  });
});
