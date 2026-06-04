/**
 * Environment variable schema definitions.
 *
 * Reads from env.config.json — the single source of truth for env var definitions.
 */

import envConfigJson from "../env.config.json";

export type DeploymentEnv = "development" | "preview" | "production";

/**
 * Detect the current deployment environment.
 */
export function getDeploymentEnv(): DeploymentEnv {
  if (process.env.NODE_ENV === "development") return "development";
  if (process.env.VERCEL_ENV === "preview") return "preview";
  return "production";
}

type RequiredFn = (env: NodeJS.ProcessEnv, deployEnv: DeploymentEnv) => boolean;

export interface EnvVarSchema {
  required: boolean | RequiredFn;
  sensitive: boolean;
  default?: string;
  description: string;
}

interface JsonEnvVarConfig {
  required: boolean | string;
  sensitive: boolean;
  default?: string;
  description: string;
}

/**
 * Convert a JSON required value to a boolean or conditional function.
 * - true/false: used as-is
 * - string (e.g. "production"): required only when deployEnv matches
 */
function parseRequired(value: boolean | string): boolean | RequiredFn {
  if (typeof value === "boolean") return value;
  return (_env, deployEnv) => deployEnv === value;
}

/**
 * Environment variable definitions, built from env.config.json.
 * Order matches the JSON key order.
 */
export const envVars: Record<string, EnvVarSchema> = Object.fromEntries(
  Object.entries(envConfigJson as Record<string, JsonEnvVarConfig>).map(
    ([name, config]) => [
      name,
      {
        required: parseRequired(config.required),
        sensitive: config.sensitive,
        ...(config.default !== undefined && { default: config.default }),
        description: config.description,
      },
    ],
  ),
);

/**
 * Check if a variable is required given current env and deployment.
 */
export function isRequired(
  schema: EnvVarSchema,
  env: NodeJS.ProcessEnv,
  deployEnv: DeploymentEnv,
): boolean {
  if (typeof schema.required === "function") {
    return schema.required(env, deployEnv);
  }
  return schema.required;
}
