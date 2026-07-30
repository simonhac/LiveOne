/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  // See jest.config.js — override the repo's `jsx: "preserve"` so `.tsx` imports compile.
  transform: {
    "^.+\\.tsx?$": ["ts-jest", { tsconfig: { jsx: "react-jsx" } }],
  },
  roots: [
    "<rootDir>/lib",
    "<rootDir>/app",
    "<rootDir>/scripts",
    "<rootDir>/packages",
  ],
  modulePathIgnorePatterns: ["/\\.next/", "/\\.next-build/"],
  testMatch: [
    "**/__tests__/**/*.test.ts",
    "**/__tests__/**/*.integration.test.ts", // Include all tests
  ],
  collectCoverageFrom: ["lib/**/*.ts", "!lib/**/*.d.ts"],
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/$1",
  },
};
