/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  // See jest.config.js — override the repo's `jsx: "preserve"` so `.tsx` imports compile.
  transform: {
    "^.+\\.tsx?$": ["ts-jest", { tsconfig: { jsx: "react-jsx" } }],
  },
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
