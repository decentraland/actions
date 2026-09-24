import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readUploadConfig } from "../src/s3";

jest.mock("@actions/core", () => ({ info: jest.fn(), setSecret: jest.fn(), debug: jest.fn() }));

/**
 * static-sites-pipeline reads a `config.yml` from the root of the built folder and merges
 * it into the uploader's configuration. Dropping it is not cosmetic: `ignore: true` is how
 * a site keeps files out of a public bucket, and a pre-compressed `*.wasm.br` gets no
 * Content-Encoding or Content-Type without its rule.
 */

let folder: string;

beforeEach(() => {
  folder = fs.mkdtempSync(path.join(os.tmpdir(), "upload-config-"));
});

afterEach(() => {
  fs.rmSync(folder, { recursive: true, force: true });
});

describe("when the built folder has no config.yml", () => {
  it("should use the same defaults the pipeline uses", () => {
    expect(readUploadConfig(folder)).toEqual({ immutable: true, concurrency: 10 });
  });
});

describe("when the built folder ships a config.yml", () => {
  beforeEach(() => {
    fs.writeFileSync(
      path.join(folder, "config.yml"),
      [
        "matches:",
        "  - match: 'static-local/**/*'",
        "    ignore: true",
        "  - match: 'unity/Build/**/*.wasm.br'",
        "    contentType: application/wasm",
        "    contentEncoding: br",
      ].join("\n"),
    );
  });

  // Without this the files a site deliberately excludes are published public-read to the
  // CDN bucket.
  it("should carry the per-file rules through", () => {
    const config = readUploadConfig(folder) as { matches?: unknown[] };

    expect(config.matches).toHaveLength(2);
  });

  it("should keep the ignore rule that holds files back from the bucket", () => {
    const config = readUploadConfig(folder) as { matches: Array<Record<string, unknown>> };

    expect(config.matches[0]).toEqual(expect.objectContaining({ ignore: true }));
  });

  it("should keep the content type and encoding a pre-compressed asset needs", () => {
    const config = readUploadConfig(folder) as { matches: Array<Record<string, unknown>> };

    expect(config.matches[1]).toEqual(
      expect.objectContaining({ contentType: "application/wasm", contentEncoding: "br" }),
    );
  });

  // Same precedence as the pipeline: a site must not be able to widen these.
  it("should not let a site override immutable or concurrency", () => {
    fs.writeFileSync(path.join(folder, "config.yml"), "immutable: false\nconcurrency: 99\n");

    expect(readUploadConfig(folder)).toEqual(
      expect.objectContaining({ immutable: true, concurrency: 10 }),
    );
  });
});

describe("when the config.yml cannot be read", () => {
  /**
   * The pipeline falls back to the defaults and logs. Here it is fatal: silently dropping
   * the rules is exactly how a file marked `ignore` ends up on a public CDN, and a deploy
   * that half-applies a site's rules is worse than one that stops.
   */
  it("should refuse to deploy rather than upload without the rules", () => {
    fs.writeFileSync(path.join(folder, "config.yml"), "matches: [oops\n  - broken");

    expect(() => readUploadConfig(folder)).toThrow(/Could not read/);
  });

  it("should say what dropping the rules would do", () => {
    fs.writeFileSync(path.join(folder, "config.yml"), "matches: [oops\n  - broken");

    expect(() => readUploadConfig(folder)).toThrow(/excludes/);
  });
});
