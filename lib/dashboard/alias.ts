/**
 * Owner-unique dashboard shortname (alias) helpers, shared by the create dialog, the settings dialog,
 * and (defensively) the server. An alias is kebab-case: lowercase a-z/0-9 segments joined by single
 * hyphens — these are the chars that survive in a `/dashboard/{user}/{shortname}` URL. Empty string
 * means "no alias".
 */

export const MAX_ALIAS_LENGTH = 64;

/**
 * Coerce arbitrary text toward a valid alias: trim, lowercase, spaces/underscores → hyphen, strip any
 * other char, collapse and trim hyphens, cap length. The result always satisfies `isValidAlias`.
 */
export function normalizeAlias(raw: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  // Slicing to the length cap can leave a dangling hyphen at the boundary; trim it.
  return cleaned.slice(0, MAX_ALIAS_LENGTH).replace(/-+$/g, "");
}

/** Whether `s` is a usable alias. Empty string is valid (means "no alias"). */
export function isValidAlias(s: string): boolean {
  if (s === "") return true;
  if (s.length > MAX_ALIAS_LENGTH) return false;
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s);
}
