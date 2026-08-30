/**
 * The canonical URL path for a composition dashboard: the pretty owner-scoped form
 * `/dashboard/{ownerUsername}/{slug}` when both parts are known, else the id form
 * `/dashboard/{db_…}`. Slugs are renameable, so the id form is the durable address —
 * anything long-lived (share links) should pass no slug and get the id form.
 */
export function dashboardHref(d: {
  id: string;
  slug?: string | null;
  ownerUsername?: string | null;
}): string {
  return d.slug && d.ownerUsername
    ? `/dashboard/${d.ownerUsername}/${d.slug}`
    : `/dashboard/${d.id}`;
}
