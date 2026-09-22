const mockUploadDir = jest.fn();

jest.mock("@dcl/cdn-uploader", () => ({ uploadDir: mockUploadDir }));

import { copyFolderInS3, prefixExists, uploadFolderToS3 } from "../src/s3";

type S3Mock = {
  listObjectsV2: jest.Mock;
  copyObject: jest.Mock;
};

/** aws-sdk v2 returns a request object whose `.promise()` resolves. */
function resolving(value: unknown) {
  return { promise: () => Promise.resolve(value) };
}

describe("when uploading a folder to S3", () => {
  let s3: S3Mock;

  beforeEach(() => {
    mockUploadDir.mockReset();
    mockUploadDir.mockResolvedValueOnce(["index.html", "index.html.gzip"]);
    s3 = { listObjectsV2: jest.fn(), copyObject: jest.fn() };
  });

  it("should pass the bucket, folder and remote folder through to the uploader", async () => {
    await uploadFolderToS3({
      region: "us-east-1",
      bucket: "cdn-bucket",
      folder: "./dist",
      remoteFolder: "@dcl/auth-site/1.0.0-commit-abc1234",
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
      s3: s3 as never,
    });

    expect(mockUploadDir).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      { immutable: true, concurrency: 10 },
    );
  });

  it("should resolve to the uploaded object keys", async () => {
    await expect(
      uploadFolderToS3({
        region: "us-east-1",
        bucket: "cdn-bucket",
        folder: "./dist",
        remoteFolder: "pkg/1.0.0",
        s3: s3 as never,
      }),
    ).resolves.toEqual(["index.html", "index.html.gzip"]);
  });
});

describe("when checking whether a version prefix is already in S3", () => {
  let s3: S3Mock;

  beforeEach(() => {
    s3 = { listObjectsV2: jest.fn(), copyObject: jest.fn() };
  });

  describe("and at least one object is stored under the prefix", () => {
    beforeEach(() => {
      s3.listObjectsV2.mockReturnValueOnce(resolving({ KeyCount: 1 }));
    });

    it("should report the version as present", async () => {
      await expect(
        prefixExists({ region: "us-east-1", bucket: "b", prefix: "pkg/1.0.0", s3: s3 as never }),
      ).resolves.toBe(true);
    });
  });

  describe("and nothing is stored under the prefix", () => {
    beforeEach(() => {
      s3.listObjectsV2.mockReturnValueOnce(resolving({ KeyCount: 0 }));
    });

    it("should report the version as absent", async () => {
      await expect(
        prefixExists({ region: "us-east-1", bucket: "b", prefix: "pkg/1.0.0", s3: s3 as never }),
      ).resolves.toBe(false);
    });
  });

  describe("and the response carries no KeyCount at all", () => {
    beforeEach(() => {
      s3.listObjectsV2.mockReturnValueOnce(resolving({}));
    });

    it("should report the version as absent rather than crashing", async () => {
      await expect(
        prefixExists({ region: "us-east-1", bucket: "b", prefix: "pkg/1.0.0", s3: s3 as never }),
      ).resolves.toBe(false);
    });
  });

  describe("and the prefix is checked", () => {
    beforeEach(() => {
      s3.listObjectsV2.mockReturnValueOnce(resolving({ KeyCount: 1 }));
    });

    it("should ask for a single key, since only existence matters", async () => {
      await prefixExists({
        region: "us-east-1",
        bucket: "b",
        prefix: "pkg/1.0.0",
        s3: s3 as never,
      });

      expect(s3.listObjectsV2).toHaveBeenCalledWith(
        expect.objectContaining({ Bucket: "b", MaxKeys: 1 }),
      );
    });
  });

  describe("and the prefix is given without a trailing slash", () => {
    beforeEach(() => {
      s3.listObjectsV2.mockReturnValueOnce(resolving({ KeyCount: 1 }));
    });

    // Without the separator `pkg/1` would prefix-match `pkg/1.0.0`, and a
    // version would be reported as deployed because a SIBLING version exists.
    it("should query exactly one trailing slash", async () => {
      await prefixExists({ region: "us-east-1", bucket: "b", prefix: "pkg/1", s3: s3 as never });

      expect(s3.listObjectsV2).toHaveBeenCalledWith(expect.objectContaining({ Prefix: "pkg/1/" }));
    });
  });

  describe("and the prefix is given with a trailing slash", () => {
    beforeEach(() => {
      s3.listObjectsV2.mockReturnValueOnce(resolving({ KeyCount: 1 }));
    });

    it("should not double the separator", async () => {
      await prefixExists({ region: "us-east-1", bucket: "b", prefix: "pkg/1/", s3: s3 as never });

      expect(s3.listObjectsV2).toHaveBeenCalledWith(expect.objectContaining({ Prefix: "pkg/1/" }));
    });
  });
});

describe("when copying a version prefix within the bucket", () => {
  let s3: S3Mock;

  beforeEach(() => {
    s3 = { listObjectsV2: jest.fn(), copyObject: jest.fn() };
    s3.copyObject.mockReturnValue(resolving({}));
  });

  describe("and the source holds more objects than one concurrency batch", () => {
    const keys = Array.from({ length: 40 }, (_, i) => `pkg/1.0.0/asset-${i}.js`);

    beforeEach(() => {
      s3.listObjectsV2.mockReturnValueOnce(resolving({ Contents: keys.map((Key) => ({ Key })) }));
    });

    it("should copy every object across the batches", async () => {
      await copyFolderInS3({
        region: "us-east-1",
        bucket: "b",
        sourceFolder: "pkg/1.0.0",
        targetFolder: "pkg/v2",
        concurrency: 16,
        s3: s3 as never,
      });

      expect(s3.copyObject).toHaveBeenCalledTimes(40);
    });

    it("should report the exact number copied", async () => {
      await expect(
        copyFolderInS3({
          region: "us-east-1",
          bucket: "b",
          sourceFolder: "pkg/1.0.0",
          targetFolder: "pkg/v2",
          concurrency: 16,
          s3: s3 as never,
        }),
      ).resolves.toBe(40);
    });
  });

  describe("and the listing is truncated across pages", () => {
    beforeEach(() => {
      s3.listObjectsV2
        .mockReturnValueOnce(
          resolving({
            Contents: [{ Key: "pkg/1.0.0/a.js" }],
            IsTruncated: true,
            NextContinuationToken: "token-2",
          }),
        )
        .mockReturnValueOnce(
          resolving({ Contents: [{ Key: "pkg/1.0.0/b.js" }], IsTruncated: false }),
        );
    });

    it("should follow the continuation token", async () => {
      await copyFolderInS3({
        region: "us-east-1",
        bucket: "b",
        sourceFolder: "pkg/1.0.0",
        targetFolder: "pkg/v2",
        s3: s3 as never,
      });

      expect(s3.listObjectsV2).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ ContinuationToken: "token-2" }),
      );
    });

    it("should copy the objects from every page", async () => {
      await expect(
        copyFolderInS3({
          region: "us-east-1",
          bucket: "b",
          sourceFolder: "pkg/1.0.0",
          targetFolder: "pkg/v2",
          s3: s3 as never,
        }),
      ).resolves.toBe(2);
    });
  });

  describe("and an object is copied", () => {
    beforeEach(() => {
      s3.listObjectsV2.mockReturnValueOnce(
        resolving({ Contents: [{ Key: "pkg/1.0.0/static/app.js" }] }),
      );
    });

    it("should rewrite the key onto the target prefix", async () => {
      await copyFolderInS3({
        region: "us-east-1",
        bucket: "b",
        sourceFolder: "pkg/1.0.0",
        targetFolder: "pkg/v2",
        s3: s3 as never,
      });

      expect(s3.copyObject).toHaveBeenCalledWith(
        expect.objectContaining({ Key: "pkg/v2/static/app.js" }),
      );
    });

    // The uploader writes `.gzip`/`.br` variants with their own Content-Encoding;
    // COPY is what carries that metadata over so the copy serves identically.
    it("should preserve the source metadata", async () => {
      await copyFolderInS3({
        region: "us-east-1",
        bucket: "b",
        sourceFolder: "pkg/1.0.0",
        targetFolder: "pkg/v2",
        s3: s3 as never,
      });

      expect(s3.copyObject).toHaveBeenCalledWith(
        expect.objectContaining({ MetadataDirective: "COPY" }),
      );
    });

    // A copy does NOT inherit the source ACL, and the bucket is a public CDN origin.
    it("should re-apply the public-read ACL", async () => {
      await copyFolderInS3({
        region: "us-east-1",
        bucket: "b",
        sourceFolder: "pkg/1.0.0",
        targetFolder: "pkg/v2",
        s3: s3 as never,
      });

      expect(s3.copyObject).toHaveBeenCalledWith(expect.objectContaining({ ACL: "public-read" }));
    });
  });

  describe("and a key needs URL encoding", () => {
    beforeEach(() => {
      s3.listObjectsV2.mockReturnValueOnce(
        resolving({
          Contents: [
            { Key: "pkg/1.0.0/my file.js" },
            { Key: "pkg/1.0.0/a+b.js" },
            { Key: "pkg/1.0.0/note#1.js" },
            { Key: "pkg/1.0.0/piñata.js" },
          ],
        }),
      );
    });

    it("should encode each segment while keeping the separators intact", async () => {
      await copyFolderInS3({
        region: "us-east-1",
        bucket: "b",
        sourceFolder: "pkg/1.0.0",
        targetFolder: "pkg/v2",
        s3: s3 as never,
      });

      const sources = s3.copyObject.mock.calls.map((call) => call[0].CopySource);
      expect(sources).toEqual([
        "/b/pkg/1.0.0/my%20file.js",
        // A literal `+` would be read back as a space by S3.
        "/b/pkg/1.0.0/a%2Bb.js",
        "/b/pkg/1.0.0/note%231.js",
        "/b/pkg/1.0.0/pi%C3%B1ata.js",
      ]);
    });
  });

  describe("and the source prefix holds nothing", () => {
    beforeEach(() => {
      s3.listObjectsV2.mockReturnValueOnce(resolving({ Contents: [] }));
    });

    // Silently succeeding would repoint the KV at an empty prefix.
    it("should fail rather than produce an empty target", async () => {
      await expect(
        copyFolderInS3({
          region: "us-east-1",
          bucket: "b",
          sourceFolder: "pkg/missing",
          targetFolder: "pkg/v2",
          s3: s3 as never,
        }),
      ).rejects.toThrow("No objects found");
    });
  });
});
