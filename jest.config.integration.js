const { transform, transformIgnorePatterns } = require("./jest.shared");

/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  transform,
  transformIgnorePatterns,
  roots: ["<rootDir>/lib", "<rootDir>/app"],
  testMatch: [
    "**/__tests__/**/*.integration.test.ts", // Only integration tests
  ],
  setupFiles: ["<rootDir>/jest.setup.integration.js"], // Load .env.local for KV credentials
  collectCoverageFrom: ["lib/**/*.ts", "!lib/**/*.d.ts"],
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/$1",
  },
};
