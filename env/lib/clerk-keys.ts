/**
 * Clerk key type detection and consistency checks.
 */

import type { ClerkKeyType, ClerkConsistencyResult } from "./types";
import type { DeploymentEnv } from "./schema";

/**
 * Detect the type of a Clerk key from its prefix.
 */
export function getClerkKeyType(key: string | undefined): ClerkKeyType {
  if (!key) return "unknown";
  if (key.startsWith("pk_test_") || key.startsWith("sk_test_")) return "test";
  if (key.startsWith("pk_live_") || key.startsWith("sk_live_")) return "live";
  return "unknown";
}

/**
 * Get the expected Clerk key type for a deployment environment.
 */
export function getExpectedKeyType(deployEnv: DeploymentEnv): ClerkKeyType {
  return deployEnv === "production" ? "live" : "test";
}

/**
 * Check Clerk key consistency between publishable and secret keys,
 * and whether they match the deployment environment.
 */
export function checkClerkConsistency(
  publishableKey: string | undefined,
  secretKey: string | undefined,
  deployEnv: DeploymentEnv,
): ClerkConsistencyResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const publishableKeyType = getClerkKeyType(publishableKey);
  const secretKeyType = getClerkKeyType(secretKey);
  const expectedType = getExpectedKeyType(deployEnv);

  if (
    publishableKeyType !== secretKeyType &&
    publishableKeyType !== "unknown" &&
    secretKeyType !== "unknown"
  ) {
    errors.push(
      `Clerk key mismatch: publishable is ${publishableKeyType}, secret is ${secretKeyType}`,
    );
  }

  if (publishableKeyType !== "unknown") {
    if (deployEnv === "production" && publishableKeyType === "test") {
      errors.push(
        `Production using test Clerk keys - expected pk_live_*/sk_live_*`,
      );
    } else if (deployEnv !== "production" && publishableKeyType === "live") {
      warnings.push(
        `Using live Clerk keys in ${deployEnv} - consider using test keys for safety`,
      );
    }
  }

  const consistent =
    errors.length === 0 &&
    publishableKeyType === secretKeyType &&
    (publishableKeyType === expectedType || publishableKeyType === "unknown");

  return {
    publishableKeyType,
    secretKeyType,
    expectedType,
    consistent,
    errors,
    warnings,
  };
}
