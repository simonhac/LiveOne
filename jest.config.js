/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  // The repo tsconfig sets `jsx: "preserve"` (Next compiles JSX itself), which ts-jest would
  // otherwise honour — emitting raw JSX that node cannot parse the moment a test imports a `.tsx`
  // component module. Override it for tests only so React components are importable/renderable.
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
    "!**/__tests__/**/*.integration.test.ts", // Exclude integration tests from default run
  ],
  collectCoverageFrom: ["lib/**/*.ts", "!lib/**/*.d.ts"],
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/$1",
  },
};
