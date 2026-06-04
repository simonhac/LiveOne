/**
 * Environment validation and reporting.
 */

import { envVars, isRequired, getDeploymentEnv } from "./schema";
import { loadEnvFileEntries, getEnvVarOrigin } from "./origin-tracer";
import { checkClerkConsistency } from "./clerk-keys";
import type { ValidationResult, EnvVarInfo, EnvOrigin } from "./types";

/**
 * Validate all environment variables.
 */
export function validateEnvironment(rootDir: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const vars: EnvVarInfo[] = [];

  const deployEnv = getDeploymentEnv();
  const fileEntries = loadEnvFileEntries(rootDir);

  for (const [name, schema] of Object.entries(envVars)) {
    const value = process.env[name];
    const required = isRequired(schema, process.env, deployEnv);
    const origin = getEnvVarOrigin(name, value, fileEntries, schema.default);

    vars.push({
      name,
      value: schema.sensitive ? (value ? "[redacted]" : undefined) : value,
      origin,
      required,
      sensitive: schema.sensitive,
    });

    if (required && origin.type === "missing") {
      errors.push(`Missing required: ${name}`);
    }
  }

  const clerkResult = checkClerkConsistency(
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
    process.env.CLERK_SECRET_KEY,
    deployEnv,
  );
  errors.push(...clerkResult.errors);
  warnings.push(...clerkResult.warnings);

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    vars,
  };
}

/**
 * Format an origin for display.
 */
function formatOrigin(origin: EnvOrigin, rootDir: string): string {
  switch (origin.type) {
    case "file": {
      const relPath = origin.path.replace(rootDir + "/", "");
      if (origin.path !== origin.realPath) {
        return `${relPath} -> ${origin.realPath}`;
      }
      return relPath;
    }
    case "environment":
      return "environment";
    case "default":
      return `default: "${origin.value}"`;
    case "missing":
      return "missing";
  }
}

/**
 * Truncate a value for display, preserving prefix for identification.
 */
function truncateValue(value: string, maxLen: number = 30): string {
  if (value.length <= maxLen) return value;
  return value.slice(0, maxLen) + "...";
}

/**
 * Format the validation result as a human-readable report.
 */
export function formatValidationReport(
  result: ValidationResult,
  rootDir: string,
): string {
  const deployEnv = getDeploymentEnv();
  const lines: string[] = [];

  lines.push("");
  lines.push("════════════════════════════════════════════════════════");
  lines.push(`  Environment Validation (${deployEnv})`);
  lines.push("════════════════════════════════════════════════════════");
  lines.push("");

  const requiredVars = result.vars.filter((v) => v.required);
  const optionalVars = result.vars.filter((v) => !v.required);

  if (requiredVars.length > 0) {
    for (const v of requiredVars) {
      const status = v.origin.type === "missing" ? "x" : "OK";
      const displayValue =
        v.origin.type === "missing"
          ? "(missing)"
          : v.sensitive
            ? "[redacted]"
            : truncateValue(v.value || "");

      lines.push(`  [${status}] ${v.name} = ${displayValue}`);
      lines.push(`       Origin: ${formatOrigin(v.origin, rootDir)}`);
    }
    lines.push("");
  }

  const setOptionalVars = optionalVars.filter(
    (v) => v.origin.type !== "missing",
  );
  if (setOptionalVars.length > 0) {
    lines.push("  Optional (configured):");
    for (const v of setOptionalVars) {
      let displayValue: string;
      if (v.sensitive) {
        displayValue = "[redacted]";
      } else if (v.origin.type === "default") {
        displayValue = `(default: ${truncateValue(v.origin.value)})`;
      } else {
        displayValue = truncateValue(v.value || "");
      }
      lines.push(`    ${v.name} = ${displayValue}`);
    }
    lines.push("");
  }

  const clerkResult = checkClerkConsistency(
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
    process.env.CLERK_SECRET_KEY,
    deployEnv,
  );
  const clerkStatus = clerkResult.consistent ? "OK" : "x";
  lines.push(
    `  Clerk Keys: ${clerkResult.publishableKeyType}/${clerkResult.secretKeyType} ` +
      `(expected: ${clerkResult.expectedType}) [${clerkStatus}]`,
  );

  if (result.warnings.length > 0) {
    lines.push("");
    lines.push("  WARNINGS:");
    for (const w of result.warnings) {
      lines.push(`    ! ${w}`);
    }
  }

  if (result.errors.length > 0) {
    lines.push("");
    lines.push("  ERRORS:");
    for (const e of result.errors) {
      lines.push(`    x ${e}`);
    }
  }

  lines.push("");
  lines.push("════════════════════════════════════════════════════════");
  lines.push("");

  return lines.join("\n");
}

export { getDeploymentEnv };
