jest.mock("@dcl/cdn-uploader", () => ({ uploadDir: jest.fn() }));

import { uploadDir } from "@dcl/cdn-uploader";
import { uploadFolderToS3 } from "../src/s3";

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
