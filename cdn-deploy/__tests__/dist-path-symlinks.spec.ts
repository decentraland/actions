import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readInputs } from "../src/inputs";

jest.mock("@actions/core", () => ({
  getInput: (name: string) => process.env[`INPUT_${name.toUpperCase().replace(/-/g, "_")}`] || "",
  getBooleanInput: () => false,
  setSecret: jest.fn(),
  info: jest.fn(),
  warning: jest.fn(),
  debug: jest.fn(),
}));

/**
 * The uploader globs `**\/*` with `dot: true` and follows symlinked directories, writing
 * every object public-read. One `dist/assets -> ../.git` therefore publishes the runner's
 * git config — which carries the AUTHORIZATION header `actions/checkout` writes — to a
 * guessable public URL, cached immutable for a year.
 *
 * Validating only the root missed this entirely, and it does not need a hostile workflow:
 * a build step or a dependency postinstall can drop the link in.
 */

let workspace: string;

function setInput(name: string, value: string) {
  process.env[`INPUT_${name.toUpperCase().replace(/-/g, "_")}`] = value;
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "distpath-"));
  process.env.GITHUB_WORKSPACE = workspace;
  fs.mkdirSync(path.join(workspace, "dist"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "dist", "index.html"), "<html></html>");
  fs.writeFileSync(
    path.join(workspace, "package.json"),
    JSON.stringify({ name: "@dcl/auth-site", version: "1.0.0" }),
  );
  // absolute: a relative path resolves against cwd, not the workspace
  setInput("dist-path", path.join(workspace, "dist"));
  setInput("deployment-environments", '["zone"]');
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) if (key.startsWith("INPUT_")) delete process.env[key];
});

describe("when the build folder contains a symlink pointing outside it", () => {
  it("should refuse a link to the repository's git directory", () => {
    fs.mkdirSync(path.join(workspace, ".git"));
    fs.writeFileSync(
      path.join(workspace, ".git", "config"),
      "extraheader = AUTHORIZATION: basic x",
    );
    fs.symlinkSync(path.join(workspace, ".git"), path.join(workspace, "dist", "assets"));

    expect(() => readInputs()).toThrow(/points outside it/);
  });

  it("should refuse a link to an absolute path elsewhere on the runner", () => {
    fs.symlinkSync("/etc", path.join(workspace, "dist", "etc"));

    expect(() => readInputs()).toThrow(/points outside it/);
  });

  it("should refuse a link nested deeper in the tree", () => {
    fs.mkdirSync(path.join(workspace, "dist", "a", "b"), { recursive: true });
    fs.symlinkSync(workspace, path.join(workspace, "dist", "a", "b", "up"));

    expect(() => readInputs()).toThrow(/points outside it/);
  });

  it("should name the offending link so it can be found", () => {
    fs.symlinkSync("/etc/passwd", path.join(workspace, "dist", "pw"));

    expect(() => readInputs()).toThrow(/pw/);
  });
});

describe("when the build folder contains ordinary symlinks", () => {
  it("should allow one pointing inside the folder", () => {
    fs.writeFileSync(path.join(workspace, "dist", "real.js"), "//");
    fs.symlinkSync(
      path.join(workspace, "dist", "real.js"),
      path.join(workspace, "dist", "alias.js"),
    );

    expect(() => readInputs()).not.toThrow();
  });

  // It publishes nothing, and the uploader skips it.
  it("should allow a dangling link rather than failing the build", () => {
    fs.symlinkSync(
      path.join(workspace, "dist", "gone.js"),
      path.join(workspace, "dist", "broken.js"),
    );

    expect(() => readInputs()).not.toThrow();
  });

  it("should allow a folder with no links at all", () => {
    expect(() => readInputs()).not.toThrow();
  });
});
