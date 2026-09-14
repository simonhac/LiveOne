# Device naming, Area Settings, and tracked aggregation rebuilds

Status: implementation handoff. Product decisions agreed; application changes have not been implemented by this document.

## Outcome and delivery

Ship two PRs against `main`:

1. **PR A — naming API, CLI, and creation.** Generate consistent Amber names, allow editing names at creation, and add owner-authorized naming through the v4 API and CLI. The existing Device Settings dialog moves to that API in PR B.
2. **PR B — settings ownership and aggregation boundaries.** Introduce Area Settings, connect owner device naming in the UI, derive fixed aggregation offsets from timezones, and add durable rebuild requirements plus resumable operator repairs.

This document is the complete handoff. No other plan or conversation is required.

### Motivation

Two production Amber devices prompted the naming work:

| Device handle | Current name when reviewed | Area |
| --- | --- | --- |
| 9 | `Amber Kinkora` | Kinkora Unified |
| 10002 | `Amber - CitiPower (6103034617)` | High Street Kew |

The generated convention should be `Amber <network> NMI <nmi>`. Confirm current production values before applying any rename.

The current Device Settings dialog offers owners a name field but saves it through an admin-only endpoint. It also edits timezone and location through device-addressed routes even though those properties belong to the area. Readers already resolve placement through the area; this work corrects the editing boundary.

### Locked decisions

- Short names are unique per owner, following the database constraint, rather than globally.
- Display timezone uses IANA local time, including daylight saving, for display and wall-clock scheduling.
- The area's aggregation offset is derived from that timezone's standard time, excluding daylight saving. Every aggregation day remains exactly 24 hours. There is no independently editable area offset.
- Changing a boundary saves the change and marks affected aggregation as needing repair; it does not start a background rebuild.
- Moving a device into an area with an incompatible aggregation offset marks a repair requirement. It does not silently rewrite device history.
- Boundary incompatibility and incomplete rebuilding are separate concepts.
- Available daily data remains visible with persistent warnings until repair succeeds.
- Operators initiate resumable repairs through the CLI.
- PR B includes an authorized additive database migration for dedicated rebuild state.
- Include a dry-run/apply audit to find and mark existing mismatches. Deployment itself does not run that audit or repairs.
- Keep two PRs even though rebuild tracking expands PR B beyond a dialog refactor.

Preserve unrelated workspace changes, especially overlapping work in `lib/areas/create.ts` and `lib/readings/prod-dev-sync.ts`. Do not rename the current branch. Follow repository migration and PR procedures.

## PR A — naming

### Amber name and creation

Add `lib/vendors/amber/device-name.ts` with a pure `amberDeviceName(site: Pick<AmberSite, "network" | "nmi">): string` helper returning `Amber ${site.network} NMI ${site.nmi}`. Import it into the adapter. Keep the helper separate from the adapter's cache and point-manager dependencies. Preserve the NMI verbatim; do not trim it or interpret it as a number. Continue storing it as the device serial.

In `components/AddDeviceDialog.tsx`, show a Device name input after Test Connection succeeds, alongside the model and serial. Seed it from the returned display name, reset it when the tested device changes, and submit the edited name in `deviceInfo.displayName`. Disable submission for invalid names or while a request is pending.

Share name validation between creation and rename:

- Require a string; store it trimmed.
- Require 1–100 characters after trimming, using the existing JavaScript string-length convention.
- Reject C0/C1 control characters before trimming, including trailing newlines.
- Enforce this on the server, not just through input controls.
- For creation, preserve the generated fallback when the request omits a name; reject an explicitly supplied invalid name.

The existing creation API does not enforce the claimed 100-character limit today: add that validation in `app/api/devices/route.ts`.

Creating an owner's first device can still create an area named after the device through `resolveOnboardingArea`. Preserve and document that behavior. Later device renames must not rename the area.

### Device PATCH

Extend `PATCH /api/v4/devices/{dv_}` in `app/api/v4/devices/[id]/route.ts` to accept either:

```ts
{ areaId: string | null }
// or, with at least one supplied field:
{ name?: string; slug?: string | null }
```

Reject non-object bodies, arrays, empty bodies, and bodies combining `areaId` with `name` or `slug`, with 422. Presence of `areaId`, including explicit `null`, remains the move/unassignment signal. Preserve the current move authorization, compare-and-set protection, refresh behavior, response shape, and safety comments.

For naming:

- Use `requireDeviceAccess(request, rid, { requireWrite: true })`; authorize device owners and admins, not area custodians merely because they own the area.
- Collapse denied access to the existing 404 `{ error: "Device not found" }` response.
- Do not use `assertDevicesRehomable` for metadata updates. Authorized helper, ambient, disabled, and removed devices can be renamed.
- Apply the shared name validation above.
- Slugs allow letters, digits, and underscores, up to 200 characters. Reject purely numeric values, matching the dialog and avoiding ambiguity with integer handles. Empty/whitespace-only strings clear to `null`; otherwise reject whitespace and invalid characters.
- Enforce uniqueness within the **target device owner's** scope, including when an admin acts for that owner. Preserve case-sensitive database semantics.
- Return generic 409 conflict errors without disclosing another device's name. Catch the existing `devices_owner_slug_unique` violation as well as any preflight collision, including concurrent writes.
- Ownerless devices follow the existing NULL-owner database semantics; do not create a new global namespace.
- Update name and slug together in one `DeviceWriter.updateDevice` call with no placement options. Do not write an area.
- Revalidate `/dashboard` layout and invalidate/refetch relevant UI data.

Return:

```ts
{ id, name, previousName, slug, previousSlug, renamed }
```

`renamed` is true if either metadata value changed. A matching value is a successful no-op. Naming does not require CAS; membership changes retain their current CAS behavior.

While the legacy admin settings route remains in PR A, align its name/slug validation and collision scope with the shared implementation. PR B deletes it.

### CLI

Add `liveone device rename <device> <name>` in `scripts/ops/device/cli.ts` and register the handler:

- Declare it mutating, with dry-run default, base URL selection, standard human/JSON output, `--apply`, and the kit's noninteractive `--yes` requirement.
- List devices once and resolve the reference against that list. Ambiguous references require an opaque ID or handle.
- Validate locally before sending any request. An unchanged name emits an already-named result without writing.
- Warn about case-insensitive display-name collisions but allow them; names are not unique keys.
- Quote old/new names with `JSON.stringify` in dry-run output, identify the area as unchanged, and explain how to apply.
- PATCH `{ name }`; map 422 to usage and 404 to findings with an owner/admin explanation. Retain standard handling for auth and upstream failures.
- Emit `{ device, from, to, alreadyNamed, collisions, applied }`.
- Explain that durable edits target prod: the periodic prod-to-dev configuration refresh overwrites dev-only names. Do not promise an exact time until the next sync.

Update API/CLI documentation, remove rename from the deferred-command list, correct the stale read-only device CLI comment, and regenerate committed CLI reference artifacts.

## PR B — settings and timezone behavior

### Dialogs and access

Create `components/areas/AreaSettingsDialog.tsx`, following Area Builder's portal, modal registration, notification, loading, and error conventions. Use the existing v4 area GET/PATCH routes.

Fields and actions:

- Area name and owner-scoped short name, using existing area alias normalization.
- AU state/postcode with the existing location merge behavior and a shared NEM-region preview component.
- Display timezone and read-only derived aggregation offset, formatted as signed minutes such as `+600m`.
- Existing archive confirmation, dependency blocking, and relied-upon messages.
- Aggregation health warning, progress/error details, and the relevant CLI repair command.

Area Builder edit mode keeps Members and Bindings only, with a Settings action in its header. Remove its General/Location editing and archive controls. Keep create mode's name/slug/member workflow; derive its timezone/offset defaults using the rule below.

Add Settings and Devices actions to `AreaTable`, with dialog state in both owner and admin area clients. Ensure edits refresh the table, open dialogs, membership information, and affected dashboards.

In `DeviceSettingsDialog`:

- Save name/slug through PR A's v4 API.
- Remove editable timezone and location, their dirty state, and device placement locking machinery.
- Show the area's timezone, the device's own aggregation offset, and compatibility/rebuild status. An unassigned device shows “No site”.
- Open Area Settings only for an area owner/admin. Device ownership alone must not expose an area edit action.
- Thread the `dv_` ID from `DeviceLayout` and the admin device client; retain the integer handle for other tabs that still require it.
- Replace the legacy settings GET with v4 detail loading. Add `dayOffsetMin` and aggregation health to the response.

Fix the v4 detail-loading access regression as part of this work: owners and explicitly acting admins must be able to fetch authorized inactive devices. Keep list/picker active filtering unchanged. Admin entry points send explicit admin read context, and query keys include that context. Handle failed loads without displaying an editable blank form.

Delete these routes after migrating all consumers:

- `app/api/admin/devices/[systemId]/settings/route.ts`
- `app/api/devices/[systemId]/location/route.ts`

Remove `DevicePatch.displayTimezone`, `DevicePatch.timezoneOffsetMin`, `describeDevicePlacement`, `PlacementRefusedError`, and required-placement branches. Retain location, best-effort placement outcomes/refusals, and Enphase reconnect's guarded location write. Document Enphase as the remaining device-to-area location writer; do not claim there are no such writers.

### Standard-time derivation

Add one shared `standardOffsetMin(timezone)` mapping covering every accepted timezone. Commit its IANA source version and effective date alongside the mapping. Use the applicable IANA base `STDOFF`, excluding the daylight-saving adjustment; do not infer it from today's offset or a January/July minimum. Those shortcuts fail for negative-DST rules. Source semantics: [IANA's timezone database guide](https://www.iana.org/time-zones/tz-how-to).

The mapping is stable until explicitly updated in code. Tests must cover fractional offsets and negative-DST zones, not just Australian and northern-hemisphere seasonal examples. A mapping update is an auditable boundary-policy change, not an automatic seasonal data rewrite.

- Display formatting and wall-clock schedules continue using the selected IANA timezone.
- Aggregation uses the fixed mapped offset throughout history, with 24-hour days; it does not follow historical or seasonal offset transitions.
- New areas derive `day_offset_min` and `timezone_offset_min` from the selected/defaulted display timezone.
- New devices placed in an area initialize their device offset from that area. Unassigned devices retain platform/vendor initialization behavior.
- Existing device offsets change through tracked repair, not immediately on moves or area edits.

Area PATCH derives both area offset columns whenever the timezone changes. For compatibility, an explicitly supplied legacy `dayOffsetMin` is accepted only when it equals the offset derived from the effective timezone; contradictions return 422. Metadata-only edits do not silently repair existing mismatches.

Before saving a timezone change, show old/new timezones and offsets. If the aggregation boundary changes, require explicit confirmation explaining that daily history needs an operator rebuild. Explain that timezone also affects local scheduling/calendar interpretation; it is not a labels-only preference.

## PR B — durable health state and repairs

### Storage and public health model

Add a dedicated `aggregation_rebuild_state` table with one row per device or area, nullable subject foreign keys, an exactly-one-subject check, and subject uniqueness. Keep this state separate from device lifecycle status, vendor adapter state, and user configuration.

Persist:

- Requirement revision and completed revision.
- Previous/target offsets and reason codes.
- `pending`, `running`, `failed`, or `complete` status.
- Phase, stable history bounds, and next cursor.
- Lease token/expiry, timestamps, and sanitized last error.

Expose two separate concepts:

- `boundaryCompatible`: a device's stored offset matches its current area's required offset. Unassigned devices are compatible by definition.
- `needsRebuild`: an outstanding durable requirement exists, or a boundary mismatch requires repair.

Offset equality never proves a partially completed rebuild succeeded. A device can already have its target offset while still needing historical reconstruction.

Use a shared `aggregationHealth` serializer in device/area detail and affected daily-data responses, carrying compatibility, requirement, status, reasons, offsets, and progress. Area health includes its own repair requirement and unresolved member prerequisites. Return only details the caller is authorized to read.

### Invalidation and visible warnings

Record metadata changes and rebuild requirements in the same transaction:

- Area boundary change: mark the area for full repair and incompatible members for device repair.
- Device move: preserve its stored offset, compare with the destination, and mark necessary repair.
- Membership/binding changes that affect materialized area history: mark affected source/destination areas.
- Wire shared writers so rehome, member replacement, onboarding, and binding edits cannot bypass tracking.
- Repeated unchanged requests do not advance revisions.
- A later relevant change advances the revision; an older worker cannot clear it.
- Returning to a compatible area may clear a never-started mismatch-only requirement, but must not clear partially rebuilt or independently invalidated history.

Keep daily data visible with persistent warnings in settings, tables, and affected daily dashboards/charts. During repair, explain that some days may temporarily be incomplete. Raw and intraday data remain available. UI controls do not start automatic repair jobs.

### Operator API and CLI

Add these commands using existing CLI conventions:

```text
liveone device rebuild <device>
liveone area rebuild <area>
liveone area audit-boundaries [area]
```

All are dry-run by default and require explicit apply flags to mutate. The audit without an area scans the caller's owned areas; explicit admin context permits a fleet audit. Audit apply corrects stored area offsets to the derived value and records requirements transactionally; it does not rebuild data.

Back commands with bounded POST endpoints under the existing v4 device/area namespaces, including a reserved static boundary-audit route under `/api/v4/areas`. Verify CLI middleware allowlisting and static route precedence.

Rebuild apply requests name the reviewed requirement revision. Persist cursors on the server: re-running the CLI resumes without manually supplying a date. Changed revisions return 409 and require a refreshed dry-run plan. Return phase, progress, completion, and failure details using standard CLI output/error conventions.

Authorize every subject being repaired. An area owner cannot rewrite another owner's device through custody alone. Area repair preflights all prerequisite permissions before writing; inaccessible device repairs are reported explicitly. An admin can perform the complete repair.

### Repair sequencing

Device repair:

1. Persist a full-history plan using source and existing aggregate extents, including boundary margins.
2. Update the device offset and persist initialization atomically.
3. Rebuild device daily aggregates in bounded retry-safe chunks.
4. Leave dependent areas marked until their repairs finish.

Area repair:

1. Finish required member-device repairs.
2. Force a full rebuild of battery daily inputs and learned parameters where a battery is bound.
3. Rebuild affected flow/provenance history, including stored blend and checkpoint outputs.
4. Refresh serving caches and complete only the current requirement revision.

Implementation anchors are `lib/aggregation/change-day-offset.ts`, `lib/aggregation/scoped-recompute.ts`, and `lib/areas/recompute-provenance.ts`. Reuse their domain calculations, but do not inherit unsuitable success semantics:

- The existing bounded provenance request uses incremental learning when `start` or `last` is supplied. It cannot prove a historical boundary repair. Force full input reconstruction.
- Existing scoped helpers log some failures and continue. Add strict repair paths that fail and persist the error; swallowed failures cannot advance successful progress.
- Replacing aggregates must remove obsolete outputs as well as upserting new outputs. Shifted boundary days with no new data must not retain stale rows.
- Persist progress only after a chunk succeeds. Initialization/deletion and retry behavior must be idempotent across process death.
- Refactor full-history learning into resumable phases where necessary to stay within serverless request budgets. No unbounded job runs inside an ordinary settings PATCH.

Coordinate overlapping repairs, daily aggregation, and boundary writers with per-subject locking and revision checks at chunk commits. Expired leases allow retry. Superseded workers cannot commit obsolete-boundary outputs or publish completion.

Missing source history is an explicit failure requiring operator attention. Retain the requirement and report coverage gaps; do not silently discard unrecoverable aggregates and declare success.

Integrate existing `device change-offset` with tracking. Assigned devices reject target offsets incompatible with their area; unassigned devices retain explicit offset changes. Ordinary partial recomputes never clear a full-history repair requirement.

### Environment isolation

Rebuild cursors, progress, and leases are environment-local. Exclude the new table from wholesale prod-to-dev copying.

When sync changes local boundaries, memberships, or relevant bindings, invalidate local state rather than copying prod completion. Extend ID-realignment and foreign-key handling for the new table. Synced data is not declared repaired merely because prod reports completion. Test sync interruption and replay alongside local pending work.

## Tests and acceptance

### PR A

- Pure Amber helper: production CitiPower example, distributor containing spaces, NMI preserved verbatim.
- Creation/rename: valid trimming; empty, whitespace-only, oversized, wrong-type, and control-character rejection.
- PATCH safety: non-object/array/empty bodies; explicit unassignment; placement/naming combination rejection; metadata updates never call move or area writers.
- Authorization: owner/admin success, unauthorized 404, helper/ambient/inactive naming.
- Slugs: same-owner rejection, cross-owner reuse, admin acting for target owner, concurrent constraint violation, clearing, numeric rejection, ownerless semantics.
- CLI: required arguments, default dry-run, apply safeguards, no-op, ambiguous references, collision warnings, server errors, human/JSON output.

### PR B

- Dialog loading/saving as owner and admin, including inactive devices and lack of area-edit permission.
- Location merge and NEM preview, archive dependencies, builder split, refresh behavior, and removed-route consumer search.
- Standard-offset mapping covers every selectable zone; fractional offsets, both hemispheres, negative DST, and seasonal transitions retain fixed 24-hour aggregation.
- Both area offset columns are asserted at the actual writer level. The route test currently mocks `updateAreaMeta`, so it cannot establish this coupling by itself.
- All boundary/member/binding writers record requirements atomically; no-op, compatible/incompatible move, unassignment, repeated changes, and zero-history subjects.
- Device-before-area ordering, full battery input reconstruction, obsolete-row removal, missing history, partial failures, restart, lease expiry, stale worker, and concurrent revision changes.
- Warnings and API health metadata persist until successful repair; offset equality alone does not clear them.
- Prod-to-dev sync and ID realignment preserve environment-local correctness.
- Existing calendar timezone validation and Enphase reconnect behavior remain green.

Run repository type checking for both app and scripts, lint, relevant Jest suites, knip, and CLI conformance. Use the running type watchers when available; do not restart the dev server or run a conflicting build to check types. Regenerate CLI reference artifacts after the final command definitions.

Use isolated dev fixtures for boundary changes and repair tests. Do not experiment on the production Amber areas. A successful HTTP response or a saved offset is not evidence of completed repair: verify persisted state and representative rebuilt outputs, including an interrupted-and-resumed run.

## Rollout and documentation

1. Merge/deploy PR A and verify its API and CLI.
2. As admin on the production devices page, run Test Connection for handles 9 and 10002 using their stored prod credentials. Read the canonical name from the returned device information; network is not reliably persisted elsewhere. Do not expose credentials in logs or the handoff.
3. List Amber devices, inspect the CLI target origin, then dry-run/apply each rename. Handle 10002 is expected to become `Amber CitiPower NMI 6103034617`; verify rather than assuming. Derive handle 9's name from Test Connection. Include `--yes` for noninteractive applies.
4. Confirm device names changed and area names did not. Let normal sync propagate configuration to dev.
5. Apply PR B's additive rebuild-state migration through repository procedures before deploying code that requires the table.
6. Deploy PR B; verify owner/admin settings, compatibility indicators, and pending warnings.
7. Run the boundary audit as a dry run. Review exact targets, then explicitly apply marking and run scoped repairs. There is no automatic fleet repair at deploy.
8. Verify completion from durable state and rebuilt data. Failed repairs remain visible and resumable.

Update `docs/architecture/api.md`, `docs/architecture/data-model.md`, `docs/cli.md`, and `docs/outage-catchup.md`, plus generated CLI references. Document:

- New naming contracts and removal of legacy device settings/location routes.
- Owner-scoped short names and private conflict messages.
- Area timezone ownership, derived fixed offsets, and separately stored device offsets.
- The retained Enphase location exception.
- Durable health states, warnings, repair authorization, resume behavior, and missing-history failure handling.
- The audit/migration rollout and environment-local sync rules.

Completion requires both PRs' user-facing behavior and the tracked repair workflow to be verified. No production rename, schema migration, audit apply, or rebuild is performed merely by adding this plan document.
