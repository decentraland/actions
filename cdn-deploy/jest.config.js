module.exports = {
  testEnvironment: "node",
  moduleFileExtensions: ["ts", "js"],
  testMatch: ["**/__tests__/**/*.spec.ts"],
  // isolatedModules: transpile only. `npm run typecheck` already type-checks
  // src AND __tests__ (tsconfig includes both), so ts-jest re-checking the
  // whole program in every worker was pure duplicate work — and a flake
  // source, since a worker under memory pressure could report a diagnostic
  // that tsc does not.
  transform: {
    "^.+\\.ts$": ["ts-jest", { isolatedModules: true }],
  },
  // src/index.ts is included: it holds the orchestration (which S3 action runs,
  // whether the KV is touched at all), which is exactly where the costly bugs
  // live. Excluding it made the headline coverage number meaningless.
  collectCoverageFrom: ["src/**/*.ts"],
  coverageDirectory: "coverage",
  // A floor, not a target. Set just under the current numbers so an accidental
  // regression fails CI instead of passing quietly.
  coverageThreshold: {
    global: { statements: 95, branches: 85, functions: 95, lines: 95 },
  },
};
