#!/usr/bin/env node
/**
 * Route-slug collision guard.
 *
 * Next.js App Router forbids two *different* dynamic slug names at the same path
 * level (e.g. `app/api/systems/[id]/` next to `app/api/systems/[systemId]/`).
 * It doesn't fail at build time — `next build` ships a "Ready" deploy and the
 * route tree only crashes at runtime route resolution (every request under the
 * affected subtree hangs). That's exactly what took prod down on 2026-06-15
 * (PR #98 → fixed in #99). This static check fails the build so it can't ship.
 *
 * Wired as `prebuild` in package.json, so it gates both Vercel's `next build`
 * and the local `npm run build:local`. Also imported by a Jest test.
 *
 * Known limitation (v1): route groups `(group)` are URL-transparent, so
 * `app/(a)/[id]/` and `app/(b)/[slug]/` collide at the same URL level without
 * being filesystem siblings — this check looks at literal sibling directories
 * only (the class of bug that bit us). Cross-route-group detection is a future
 * enhancement.
 */

import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const DYNAMIC = /^\[.*\]$/; // matches [id], [...slug], [[...sign-in]]

/**
 * Walk `appDir` and return every directory whose immediate children include
 * more than one distinct dynamic segment name.
 *
 * @param {string} appDir absolute path to the `app/` directory
 * @returns {Array<{ parent: string, names: string[] }>} collisions (parent is
 *   relative to appDir's parent, e.g. "app/api/systems")
 */
export function findSlugCollisions(appDir) {
  const collisions = [];
  const root = join(appDir, "..");

  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const dirs = entries.filter((e) => e.isDirectory());
    const dynamicNames = dirs
      .map((e) => e.name)
      .filter((name) => DYNAMIC.test(name));

    const distinct = [...new Set(dynamicNames)].sort();
    if (distinct.length > 1) {
      collisions.push({ parent: relative(root, dir), names: distinct });
    }

    for (const e of dirs) walk(join(dir, e.name));
  };

  walk(appDir);
  return collisions;
}

// CLI entry — only runs when invoked directly, not when imported.
const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (invokedDirectly) {
  const appDir = join(process.cwd(), "app");
  const collisions = findSlugCollisions(appDir);

  if (collisions.length > 0) {
    console.error(
      "\n✗ Route-slug collision(s) found — Next.js App Router forbids different\n" +
        "  dynamic slug names at the same path level (breaks the prod route tree):\n",
    );
    for (const { parent, names } of collisions) {
      console.error(`    ${parent}/  →  ${names.join("  vs  ")}`);
    }
    console.error(
      "\n  Rename the segments to a single shared slug name (the URL is unchanged).\n",
    );
    process.exit(1);
  }
}
