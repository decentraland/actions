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
    expect(readUploadConfig(folder)).toEqual(
      expect.objectContaining({ immutable: true, concurrency: 10 }),
    );
  });

  // uploadDir honours these too. A site setting dryRun, or an empty variants list, uploads
  // nothing while the run reports success right up to the "folder is empty" check, which
  // then blames the build.
  it("should pin the other options uploadDir honours", () => {
    expect(readUploadConfig(folder)).toEqual(
      expect.objectContaining({ dryRun: false, skipRepeated: false }),
    );
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
    fs.writeFileSync(
      path.join(folder, "config.yml"),
      ["immutable: false", "concurrency: 99", "dryRun: true", "matches:", "  - match: '**/*'"].join(
        "\n",
      ),
    );

    expect(readUploadConfig(folder)).toEqual(
      expect.objectContaining({ immutable: true, concurrency: 10, dryRun: false }),
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

describe("when the config.yml parses but carries no usable rules", () => {
  /**
   * The uploader only applies rules when `matches` is an array, so a one-letter typo, a
   * scalar, or a top-level list all yield a config with NO rules — and a site relying on
   * `ignore:` to keep files out of a public bucket loses that silently. Being fatal is the
   * whole reason the file is read at all.
   */
  const cases: Array<[string, string]> = [
    ["matches is misspelled", "mathces:\n  - match: 'a/**'"],
    ["matches is not a list", "matches: not-a-list"],
    ["the document is a list", "- match: 'a/**'"],
    ["the document is a scalar", "just-a-string"],
    ["a rule has no match string", "matches:\n  - ignore: true"],
  ];

  it.each(cases)("should refuse when %s", (_name, yaml) => {
    fs.writeFileSync(path.join(folder, "config.yml"), yaml);

    expect(() => readUploadConfig(folder)).toThrow(/apply none of them/);
  });

  it("should say the ignore rules would not be applied", () => {
    fs.writeFileSync(path.join(folder, "config.yml"), "mathces:\n  - match: 'a/**'");

    expect(() => readUploadConfig(folder)).toThrow(/ignore/);
  });
});
