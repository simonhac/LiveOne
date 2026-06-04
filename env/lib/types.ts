/**
 * Origin of an environment variable value.
 */
export type EnvOrigin =
  | { type: "file"; path: string; realPath: string }
  | { type: "environment" }
  | { type: "default"; value: string }
  | { type: "missing" };

/**
 * Information about a single environment variable.
 */
export interface EnvVarInfo {
  name: string;
  value: string | undefined;
  origin: EnvOrigin;
  required: boolean;
  sensitive: boolean;
}

/**
 * Result of environment validation.
 */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  vars: EnvVarInfo[];
}

/**
 * Clerk key type detected from prefix.
 */
export type ClerkKeyType = "test" | "live" | "unknown";

/**
 * Result of Clerk key consistency check.
 */
export interface ClerkConsistencyResult {
  publishableKeyType: ClerkKeyType;
  secretKeyType: ClerkKeyType;
  expectedType: ClerkKeyType;
  consistent: boolean;
  errors: string[];
  warnings: string[];
}
