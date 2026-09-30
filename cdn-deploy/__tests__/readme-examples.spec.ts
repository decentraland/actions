import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";

/**
 * Both READMEs ship copy-pasteable workflows, and a snippet the action rejects is worse
 * than no snippet: the reader follows it, the build runs, and the run fails. That has now
 * happened twice — the root README's quick start, then the same shape in the action's own
 * README, each found by review rather than by anything here.
 *
 * The two files are separate entry points and drifted independently, so this checks both.
 */
const root = path.join(__dirname, "..", "..");
const READMES = [
  ["README.md", path.join(root, "README.md")],
  ["cdn-deploy/README.md", path.join(root, "cdn-deploy", "README.md")],
] as const;

const action = yaml.load(fs.readFileSync(path.join(root, "cdn-deploy", "action.yml"), "utf8")) as {
  inputs: Record<string, unknown>;
};

type Example = { readme: string; line: number; with: Record<string, unknown> };

/** Every yaml block that mentions the action, whether or not it could be parsed. */
const blocksMentioningTheAction = (): Array<{ readme: string; line: number }> => {
  const out: Array<{ readme: string; line: number }> = [];
  for (const [name, file] of READMES) {
    const text = fs.readFileSync(file, "utf8");
    for (const block of text.matchAll(/```yaml\n([\s\S]*?)```/g)) {
      if (!block[1].includes("cdn-deploy@")) continue;
      out.push({ readme: name, line: text.slice(0, block.index).split("\n").length });
    }
  }
  return out;
};

/** Every `uses: …/cdn-deploy…` step in every yaml block, with the inputs it passes. */
function examples(): Example[] {
  const found: Example[] = [];

  for (const [name, file] of READMES) {
    const text = fs.readFileSync(file, "utf8");
    for (const block of text.matchAll(/```yaml\n([\s\S]*?)```/g)) {
      const body = block[1];
      if (!body.includes("cdn-deploy@")) continue;
      const line = text.slice(0, block.index).split("\n").length;

      // The snippets are workflow fragments, not whole documents, so they are read as a
      // step list where possible and scraped otherwise.
      let steps: Array<Record<string, unknown>> = [];
      try {
        const parsed = yaml.load(body) as unknown;
        const candidates = Array.isArray(parsed)
          ? parsed
          : ((Object.values((parsed as Record<string, never>) ?? {}).flatMap((v) =>
              typeof v === "object" && v ? Object.values(v) : [],
            ) as unknown[]) ?? []);
        steps = candidates.flatMap((c) =>
          typeof c === "object" && c && "steps" in c
            ? ((c as { steps: Array<Record<string, unknown>> }).steps ?? [])
            : typeof c === "object" && c
              ? [c as Record<string, unknown>]
              : [],
        );
      } catch {
        steps = [];
      }

      for (const step of steps) {
        const uses = typeof step.uses === "string" ? step.uses : "";
        if (!uses.includes("cdn-deploy@")) continue;
        found.push({ readme: name, line, with: (step.with as Record<string, unknown>) ?? {} });
      }
    }
  }
  return found;
}

describe("when a README shows how to call the action", () => {
  const all = examples();

  /**
   * Without this the suite is quietly optional: a snippet that fails to parse yields no
   * steps, so every assertion below simply stops running for it. Found by mutating a
   * snippet into malformed yaml and watching the test count drop instead of go red.
   */
  it("should find a call in every block that mentions the action", () => {
    const blocks = blocksMentioningTheAction().map((b) => `${b.readme}:${b.line}`);
    const parsed = all.map((e) => `${e.readme}:${e.line}`);

    expect(blocks.filter((b) => !parsed.includes(b))).toEqual([]);
  });

  it.each(all.map((e) => [`${e.readme}:${e.line}`, e]))(
    "should only pass inputs the action declares (%s)",
    (_where, example) => {
      const declared = Object.keys(action.inputs);
      const passed = Object.keys((example as Example).with);

      expect(passed.filter((p) => !declared.includes(p))).toEqual([]);
    },
  );

  // The exact combination the action refuses: a build with nowhere to put its output.
  it.each(all.map((e) => [`${e.readme}:${e.line}`, e]))(
    "should not show a call the action rejects (%s)",
    (_where, example) => {
      const w = (example as Example).with;

      if (w["build-command"]) expect(w["dist-path"]).toBeDefined();
    },
  );
});
