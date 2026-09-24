const mockUploadDir = jest.fn();
const mockS3Constructor = jest.fn();

jest.mock("@dcl/cdn-uploader", () => ({ uploadDir: mockUploadDir }));
jest.mock("aws-sdk", () => {
  const actual = jest.requireActual("aws-sdk");
  return {
    ...actual,
    S3: function S3(this: unknown, options: unknown) {
      mockS3Constructor(options);
      return { putObject: () => ({ promise: async () => undefined }) };
    },
  };
});

import * as AWS from "aws-sdk";
import { uploadFolderToS3, writeCompletionMarker } from "../src/s3";

/**
 * The action holds no credentials of its own: the broker mints a session scoped to one
 * prefix. aws-sdk v2 silently falls back to its default chain -- ambient AWS_ACCESS_KEY_ID,
 * or instance metadata on a self-hosted runner -- if a client is built without explicit
 * credentials, which would sign uploads with something far wider than was granted.
 *
 * Every other test injects its own `s3`, so the real construction never runs there and
 * removing `credentials` from it left the whole suite green.
 */

const credentials = new AWS.Credentials({ accessKeyId: "AKIA", secretAccessKey: "secret" });

describe("when the S3 client is built for an upload", () => {
  beforeEach(() => {
    mockS3Constructor.mockClear();
    mockUploadDir.mockReset();
    mockUploadDir.mockResolvedValue(["index.html"]);
  });

  it("should be given the brokered credentials explicitly", async () => {
    await uploadFolderToS3({
      region: "us-east-1",
      bucket: "cdn-bucket",
      folder: "./dist",
      remoteFolder: "@dcl/auth-site/1.0.0",
      credentials,
    });

    expect(mockS3Constructor).toHaveBeenCalledWith(expect.objectContaining({ credentials }));
  });

  it("should never fall back to the ambient credential chain", async () => {
    await uploadFolderToS3({
      region: "us-east-1",
      bucket: "cdn-bucket",
      folder: "./dist",
      remoteFolder: "@dcl/auth-site/1.0.0",
      credentials,
    });

    expect(mockS3Constructor.mock.calls[0][0]).toHaveProperty("credentials");
    expect(
      (mockS3Constructor.mock.calls[0][0] as { credentials?: unknown }).credentials,
    ).toBeDefined();
  });
});

describe("when the S3 client is built for the completion marker", () => {
  beforeEach(() => mockS3Constructor.mockClear());

  it("should be given the brokered credentials explicitly", async () => {
    await writeCompletionMarker({
      region: "us-east-1",
      bucket: "cdn-bucket",
      remoteFolder: "@dcl/auth-site/1.0.0",
      credentials,
      marker: {
        package: "@dcl/auth-site",
        version: "1.0.0",
        commit: "abc1234",
        objectCount: 1,
        kind: "upload",
        completedAt: "2026-09-24T12:00:00.000Z",
      },
    });

    expect(mockS3Constructor).toHaveBeenCalledWith(expect.objectContaining({ credentials }));
  });
});
