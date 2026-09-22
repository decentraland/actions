module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  moduleFileExtensions: ["ts", "js"],
  testMatch: ["**/__tests__/**/*.spec.ts"],
  // src/index.ts is included: it holds the orchestration (which S3 action runs,
  // whether the KV is touched at all), which is exactly where the costly bugs
  // live. Excluding it made the headline coverage number meaningless.
  collectCoverageFrom: ["src/**/*.ts"],
  coverageDirectory: "coverage",
};
