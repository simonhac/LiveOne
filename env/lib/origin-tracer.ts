/**
 * Trace the origin of environment variables.
 * Detects whether vars come from .env files (with symlink resolution) or environment.
 */

import fs from "fs";
import path from "path";
import type { EnvOrigin } from "./types";

interface EnvFileEntry {
  value: string;
  filePath: string;
  realPath: string;
}

/**
 * Parse a .env file format (KEY=value, with quotes support).
 */
function parseEnvFile(content: string): Map<string, string> {
  const entries = new Map<string, string>();

  for (const line of content.split("\n")) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) continue;

    const match = trimmed.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!match) continue;

    let value = match[2];

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    entries.set(match[1], value);
  }

  return entries;
}

/**
 * Load all .env files that Next.js would load, in order.
 * Later files override earlier ones.
 * Returns map of var name -> file info (including symlink resolution).
 */
export function loadEnvFileEntries(rootDir: string): Map<string, EnvFileEntry> {
  const result = new Map<string, EnvFileEntry>();
  const mode = process.env.NODE_ENV || "development";

  const envFiles = [".env", ".env.local", `.env.${mode}`, `.env.${mode}.local`];

  for (const filename of envFiles) {
    const filePath = path.join(rootDir, filename);

    try {
      const stats = fs.lstatSync(filePath);
      const realPath = stats.isSymbolicLink()
        ? fs.realpathSync(filePath)
        : filePath;

      const content = fs.readFileSync(filePath, "utf-8");
      const entries = parseEnvFile(content);

      for (const [name, value] of entries) {
        result.set(name, { value, filePath, realPath });
      }
    } catch {
      // File doesn't exist - skip
    }
  }

  return result;
}

/**
 * Determine the origin of an environment variable.
 */
export function getEnvVarOrigin(
  name: string,
  currentValue: string | undefined,
  fileEntries: Map<string, EnvFileEntry>,
  defaultValue?: string,
): EnvOrigin {
  if (currentValue === undefined) {
    if (defaultValue !== undefined) {
      return { type: "default", value: defaultValue };
    }
    return { type: "missing" };
  }

  const fileEntry = fileEntries.get(name);
  if (fileEntry && fileEntry.value === currentValue) {
    return {
      type: "file",
      path: fileEntry.filePath,
      realPath: fileEntry.realPath,
    };
  }

  return { type: "environment" };
}
