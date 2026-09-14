# `provenance-daily` authorizes the device and serves the area

> **Status:** plan — raised 2026-09-15 out of an external review of the CLI-gap branch
> (`simonhac/cli-gap-tracking`). Not yet fixed. **Latent, not live**: the one colliding handle on
> prod today has the same owner on both legs, so there is no privilege gap to exploit right now.
> Not introduced by that branch; found while judging whether to admit the route to `cliTokenRoutes`.

## The defect

`GET /api/v4/areas/{ar_…}/provenance-daily` is addressed by an **area** TypeID, resolves that area,
and then authorizes as though the caller had asked for a **device**:

```ts
// app/api/v4/areas/[id]/provenance-daily/route.ts:51-63
const loaded = await loadProvenanceArea(id);          // resolves the AREA from ar_…
const { area } = loaded;

if (area.legacySystemId != null) {
  const authResult = await requireDashboardAccess(request, area.legacySystemId);
  //                  ^ 4th parameter `prefer` defaults to "device" (lib/api-auth.ts:340)
  …
}
…
await readProvenanceDaily(db, area.uuid, area.legacySystemId, { start, end });
//                            ^ reads the AREA — the entity that was never authorized
```

The area branch inside `requireDashboardAccess` is gated on the preference:

```ts
// lib/api-auth.ts:387
if (area && (prefer === "area" || !device)) { …authorize the AREA against its own owner… }
…
return requireDeviceAccess(request, systemId, {}, timer);   // otherwise: authorize the DEVICE
```

So when a handle names **both** an area and a device, `prefer: "device"` skips the area check
entirely and the request is authorized against the device. The response is the area's battery fold.

🛑 **This is a known trap that this route was missed by.** The comment immediately above that line
(`lib/api-auth.ts:375-383`) documents it, names the colliding handle, and says the
`prefer === "area"` disjunct **is** the Phase 13 PR 2 authorization fix:

> *"Previously this branch was gated on `isAreaHandle` — i.e. `!device && area` — so a COLLIDING
> handle (13) never reached it and `/api/data`'s `?areaId=` re-take inherited the device-first grant
> for the wider entity."*

`/api/data` and `/api/history` were fixed by threading `address.prefer` through. `provenance-daily`
was not, and it is the route where the mismatch is most clearly wrong: the URL **names the entity**,
so there is no ambiguity for the preference to resolve.

## Scope: one route, and the invariant that separates it

Every `requireDashboardAccess` call site, and why only one is affected:

| Call site | `prefer` | What it then reads | Affected |
| --- | --- | --- | --- |
| `app/api/history/route.ts:575` | `address.prefer` | `authResult.subject` | no |
| `app/api/data/route.ts:110` | `address.prefer` | `authResult.subject` | no |
| `app/api/data/route.ts:59` (batch) | default `device` | `authResult.subject` | no |
| `app/api/device/[systemId]/run-periods/route.ts:349` | default `device` | `authResult.subject` | no |
| `app/api/v4/areas/[id]/provenance-daily/route.ts:57` | default `device` | **`area.uuid`**, resolved independently | **yes** |

**The invariant, stated positively:** *read `authResult.subject`, or pass the `prefer` that matches
what you are going to read.* The two default-preference call sites are safe not by luck but because
they consume the subject the gate itself resolved — authorize and read cannot disagree. This route
is the only one that resolves its entity separately from its authorization, which is exactly what
lets the two drift apart.

## Exposure, if it bites

A caller who can read the **device** at handle N receives the battery-provenance fold of the
**area** at handle N: per day, `soc_first/last/min`, sample counts, learned capacity, round-trip and
charge efficiency, reserve floor, idle loss, and the fold checkpoint scalars.

`requireDeviceAccess`'s read term is `isAdmin || isClaudeDev || isOwner || isPublic`, and `isPublic`
means **ownerless** — so the sharpest shape is an ownerless (public) device sharing a handle with an
area somebody owns. A caller who owns the device leg while another user owns the area leg is the
same hole by a different route.

## Prod state, measured 2026-09-15

- **One colliding handle exists: 13** — area *Kutis* and device *Kutis*. This is the same handle the
  `api-auth.ts` comment names, so the shape is real, not hypothetical.
- **Both legs of 13 have the same owner**, so there is no privilege gap to cross today.
- The two ownerless devices (11, 12 — the OpenElectricity NEM regions) collide with **no** area.
- Area 13 currently holds **0** `battery_provenance_daily` rows, so even the collision that exists
  would serve an empty payload.

Latent, therefore — but not a curiosity. Colliding handles are a **supported, deliberate** state:
`area delete` nulls `legacy_handles.area_id` rather than deleting the row precisely so a handle
shared with a device keeps resolving, and areas-of-one are device-backed by construction. The next
collision is a normal operation away, and it will not announce itself.

## Why this did not block the CLI-token admission

`/api/v4/areas/:id/provenance-daily` was added to `cliTokenRoutes` on the CLI-gap branch, so that
`liveone area provenance --daily` can read the fold's learned parameters. That admission does not
widen this defect:

- The route is already in **`shareableRoutes`**, so an *anonymous* `?access=` share-token viewer
  reaches it today.
- Any logged-in browser session reaches it through ordinary Clerk auth.
- A `lo_cli_` bearer is a **real user credential** for a user who could already request this URL
  from a browser. The edge bypass is presence-only; the handler remains the enforcement point.

So the hole, such as it is, is equally open without the admission. Reverting the matcher entry would
remove a capability and fix nothing.

## The fix

1. **Confirm the blast radius first.** Re-run the collision census (compare `area list` and
   `device list` handles, fleet-wide) and check whether any colliding pair has *asymmetric* owners
   or an ownerless device leg. That decides whether this is a latent trap or a live hole, which
   changes the urgency but not the change.
2. **Pass `prefer: "area"`** at `provenance-daily/route.ts:57`. One argument — the entity authorized
   becomes the entity read.
   🛑 **This NARROWS access, and the narrowing is silent.** Anyone currently admitted via the device
   leg loses it. The route's own header warns about exactly this failure mode for the share-token
   path: *"the route works perfectly for every logged-in tester and 404s for every shared-dashboard
   viewer"*, and the symptom is a blank history panel, not an error. Drive a real share token with
   no session before and after.
3. **Add a colliding-handle test.** The property — *authorize the entity you serve* — is asserted
   nowhere today, which is why a documented fix could be applied to two routes and missed on a
   third. Assert it for all five call sites in the table above, so the next route inherits the
   check rather than the bug.
4. Consider making `prefer` a **required** parameter of `requireDashboardAccess`. The default is
   what carried the defect: `"device"` is a silent, load-bearing choice at a call site whose author
   is thinking about an area. A required argument turns the trap into a compile error.

## Verification

- A colliding handle where the device is readable and the area is not returns **404/403**, not the
  area's fold.
- A pure-area handle (7, 8, 1000002, 1000003 — no device leg) is unchanged: `!device` already takes
  the area branch under either preference.
- An anonymous `?access=` share-token viewer whose dashboard scope includes the area still loads the
  battery-provenance history panel.
- `liveone area provenance <area> --daily` still works for the area's owner and under `--admin`.
