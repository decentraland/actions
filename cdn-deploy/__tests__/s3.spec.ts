jest.mock("@dcl/cdn-uploader", () => ({ uploadDir: jest.fn() }));

import { uploadDir } from "@dcl/cdn-uploader";
import { copyFolderInS3, objectExists, uploadFolderToS3 } from "../src/s3";

type PromisableMock = jest.Mock & { calls?: unknown[] };

/** aws-sdk v2 returns `{ promise() }`; this builds such a mock. */
function s3Method(impl: (...args: unknown[]) => unknown): PromisableMock {
  return jest.fn((...args: unknown[]) => ({ promise: () => Promise.resolve(impl(...args)) }));
}

describe("when uploading a folder to S3", () => {
  let uploadDirMock: jest.MockedFunction<typeof uploadDir>;
  let s3: object;

  beforeEach(() => {
    uploadDirMock = uploadDir as jest.MockedFunction<typeof uploadDir>;
    uploadDirMock.mockResolvedValue(["index.html", "main.js"]);
    s3 = {};
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  describe("and an S3 client is provided", () => {
    it("should upload with immutable caching and a concurrency of 10 under <package>/<version>", async () => {
      await uploadFolderToS3({
        region: "us-east-1",
        bucket: "cdn-bucket",
        folder: "/tmp/dist",
        remoteFolder: "@dcl/auth-site/1.0.0",
        s3: s3 as never,
      });

      expect(uploadDirMock).toHaveBeenCalledWith(s3, "cdn-bucket", "/tmp/dist", "@dcl/auth-site/1.0.0", {
        immutable: true,
        concurrency: 10,
        dryRun: undefined,
      });
    });
  });

  describe("and uploadDir reports the uploaded files", () => {
    it("should return the list of uploaded files", async () => {
      await expect(
        uploadFolderToS3({
          region: "us-east-1",
          bucket: "cdn-bucket",
          folder: "/tmp/dist",
          remoteFolder: "r",
          s3: s3 as never,
        })
      ).resolves.toEqual(["index.html", "main.js"]);
    });
  });
});

describe("when copying a folder in S3", () => {
  let listObjectsV2: jest.Mock;
  let copyObject: jest.Mock;
  let s3: { listObjectsV2: jest.Mock; copyObject: jest.Mock };

  beforeEach(() => {
    copyObject = s3Method(() => ({}));
    listObjectsV2 = jest.fn();
    s3 = { listObjectsV2, copyObject };
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  describe("and the source prefix spans multiple pages", () => {
    beforeEach(() => {
      listObjectsV2
        .mockReturnValueOnce({
          promise: () =>
            Promise.resolve({
              Contents: [{ Key: "@dcl/auth-site/snap/index.html" }],
              IsTruncated: true,
              NextContinuationToken: "page-2",
            }),
        })
        .mockReturnValueOnce({
          promise: () =>
            Promise.resolve({
              Contents: [{ Key: "@dcl/auth-site/snap/main.js.br" }],
              IsTruncated: false,
            }),
        });
    });

    it("should copy every object across all pages", async () => {
      const copied = await copyFolderInS3({
        region: "us-east-1",
        bucket: "cdn-bucket",
        sourceFolder: "@dcl/auth-site/snap",
        targetFolder: "@dcl/auth-site/1.2.3",
        s3: s3 as never,
      });

      expect(copied).toBe(2);
    });

    it("should remap the source prefix to the target prefix on each key", async () => {
      await copyFolderInS3({
        region: "us-east-1",
        bucket: "cdn-bucket",
        sourceFolder: "@dcl/auth-site/snap",
        targetFolder: "@dcl/auth-site/1.2.3",
        s3: s3 as never,
      });

      const targetKeys = copyObject.mock.calls.map((c) => (c[0] as { Key: string }).Key);
      expect(targetKeys).toEqual([
        "@dcl/auth-site/1.2.3/index.html",
        "@dcl/auth-site/1.2.3/main.js.br",
      ]);
    });
  });

  describe("and an object is copied", () => {
    beforeEach(() => {
      listObjectsV2.mockReturnValueOnce({
        promise: () =>
          Promise.resolve({ Contents: [{ Key: "@dcl/auth-site/snap/index.html" }], IsTruncated: false }),
      });
    });

    it("should copy with COPY metadata directive and public-read ACL", async () => {
      await copyFolderInS3({
        region: "us-east-1",
        bucket: "cdn-bucket",
        sourceFolder: "@dcl/auth-site/snap",
        targetFolder: "@dcl/auth-site/1.2.3",
        s3: s3 as never,
      });

      expect(copyObject).toHaveBeenCalledWith(
        expect.objectContaining({ MetadataDirective: "COPY", ACL: "public-read" })
      );
    });

    it("should build a CopySource that encodes segments but keeps the slashes", async () => {
      await copyFolderInS3({
        region: "us-east-1",
        bucket: "cdn-bucket",
        sourceFolder: "@dcl/auth-site/snap",
        targetFolder: "@dcl/auth-site/1.2.3",
        s3: s3 as never,
      });

      expect((copyObject.mock.calls[0][0] as { CopySource: string }).CopySource).toBe(
        "/cdn-bucket/%40dcl/auth-site/snap/index.html"
      );
    });
  });

  describe("and there are no objects under the source prefix", () => {
    beforeEach(() => {
      listObjectsV2.mockReturnValueOnce({
        promise: () => Promise.resolve({ Contents: [], IsTruncated: false }),
      });
    });

    it("should throw a no-objects-found error", async () => {
      await expect(
        copyFolderInS3({
          region: "us-east-1",
          bucket: "cdn-bucket",
          sourceFolder: "@dcl/auth-site/missing",
          targetFolder: "@dcl/auth-site/1.2.3",
          s3: s3 as never,
        })
      ).rejects.toThrow("No objects found under s3://cdn-bucket/@dcl/auth-site/missing/ to copy.");
    });
  });
});

describe("when checking if an S3 object exists", () => {
  let headObject: jest.Mock;
  let s3: { headObject: jest.Mock };

  beforeEach(() => {
    headObject = jest.fn();
    s3 = { headObject };
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  describe("and the object exists", () => {
    beforeEach(() => {
      headObject.mockReturnValueOnce({ promise: () => Promise.resolve({}) });
    });

    it("should return true", async () => {
      await expect(
        objectExists({ region: "us-east-1", bucket: "b", key: "x/index.html", s3: s3 as never })
      ).resolves.toBe(true);
    });
  });

  describe("and the object is missing (404)", () => {
    beforeEach(() => {
      headObject.mockReturnValueOnce({ promise: () => Promise.reject({ statusCode: 404 }) });
    });

    it("should return false", async () => {
      await expect(
        objectExists({ region: "us-east-1", bucket: "b", key: "x/index.html", s3: s3 as never })
      ).resolves.toBe(false);
    });
  });

  describe("and the head request fails with a non-404 error", () => {
    beforeEach(() => {
      headObject.mockReturnValueOnce({
        promise: () => Promise.reject({ statusCode: 500, message: "boom" }),
      });
    });

    it("should propagate the error", async () => {
      await expect(
        objectExists({ region: "us-east-1", bucket: "b", key: "x/index.html", s3: s3 as never })
      ).rejects.toEqual({ statusCode: 500, message: "boom" });
    });
  });
});
