const { transform, transformIgnorePatterns } = require("./jest.shared");

/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  transform,
  transformIgnorePatterns,
  roots: [
    "<rootDir>/lib",
    "<rootDir>/app",
    "<rootDir>/scripts",
    "<rootDir>/packages",
  ],
  modulePathIgnorePatterns: [
    "/\\.next/",
    "/\\.next-build/",
    "/\\.next-analyze/",
    "/\\.next-e2e/",
  ],
  testMatch: [
    "**/__tests__/**/*.test.ts",
    "**/__tests__/**/*.integration.test.ts", // Include all tests
  ],
  collectCoverageFrom: ["lib/**/*.ts", "!lib/**/*.d.ts"],
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/$1",
  },
};
