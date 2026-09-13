# Vendor credential handling

Gousher owns no credentials. Selectronic and Sigenergy sign-in details stay in LiveOne; the
collector fetches the ones assigned to it, keeps an encrypted copy only so that it can recover
from a control-plane outage, and uses them in memory. Deep Sea and Fronius are LAN devices and
have no credentials at all.

This document records where each copy lives, why, and what the invariants are. The code is the
source of truth: `lib/collectors/api.ts` (issuer), `lib/secure-credentials.ts` (store) and
`packages/gousher/internal/gousher/runtime.go` (holder).

## System of record: Clerk private metadata

Vendor credentials live in the device owner's Clerk `privateMetadata`, in the same v1.1
`{version, credentials[]}` record every other LiveOne vendor adapter reads. They are **not** in
`devices.config`, and **not** in `managed_pollers`: that table holds host, port, unit id, region
and auth mode only, so a database reader learns how a site is addressed but never how to log in.

The credential issuer resolves the owner from the poller's device (`devices.ownerUserId`) and calls
`getDeviceCredentials`. Rotating a password is therefore a Clerk edit; nothing on the collector
needs to be touched.

## Issue: one poller at a time, strict allow-list

`GET /api/collectors/me/credentials?pollerId=…` requires a dedicated `lo_col_<uuid>_<64 hex>`
bearer. Only its SHA-256 hash is stored (`collectors.token_hash`), compared with
`timingSafeEqual`; a disabled collector is rejected. The poller must exist, must not be deleted,
and must belong to the calling collector — a collector cannot ask for another site's credentials
by guessing a poller id.

The response carries `{revision, credentials}` and is filtered through a hard-coded allow-list:

| source | keys exported |
| --- | --- |
| `selectronic` | `email`, `password` |
| `sigenergy` | `username`, `password` |
| `deepsea`, `fronius` | none |

The allow-list exists because the stored credential record is a vendor-shaped bag that can contain
more than the collector needs — in particular a production ingestion `apiKey`. An isolated trial
collector must never receive one, so the endpoint enumerates what may leave rather than filtering
what may not.

## Hold: encrypted cache, separate refresh, hashed change detection

`Runtime.sync` fetches configuration with an ETag and then, **on every cycle including a 304**,
issues one credential GET per cloud poller. Credentials therefore refresh on the normal 30-second
config cadence (backing off to five minutes during an outage) even when no setting changed. A
response whose `revision` does not match the poller's is rejected with "credentials changed during
configuration fetch": the pair is applied together or not at all.

On disk there is exactly one copy: `<DataDir>/config.enc`, holding destination, config and the
`pollerId → {key: value}` credential map. It is sealed with AES-256-GCM (random nonce, AAD
`gousher-v1`) under `GOUSHER_INSTANCE_KEY` — 32 bytes as 64 hex characters, supplied in the
environment and never written to the volume. It is written by `AtomicWrite` at `0600` inside a
`0700` data directory, and pins the receiver destination so a decrypted snapshot cannot be
re-aimed at another origin.

The cache exists for one reason: to let a restarted collector resume collection while LiveOne is
unreachable. It is not a fallback for authorization — a shadow read still needs a fresh
boot-bound permit.

Change detection compares a SHA-256 `credentialHash`, never the plaintext. An unchanged hash with
unchanged connection settings reuses the running source untouched; a changed hash rebuilds **only**
the affected reader, leaving every other poller collecting. A cloud poller whose password is
missing or empty fails closed at `newSource` — "vendor credentials are unavailable" — and surfaces
as health error `credential-unavailable` rather than starting a reader that will loop on 401s.

## Use and containment

Credentials are used only at vendor login, from memory:

- **Selectronic** posts `email` / `pwd` as a form to select.live and keeps the session in a cookie jar.
- **Sigenergy** legacy mode AES-CBC-encrypts the password with the vendor's own fixed key before
  posting to the OAuth endpoint; openapi mode posts it as JSON over TLS. Both derive a stable
  `userDeviceId` by hashing `liveone:<username>:<region>` rather than sending anything else.

Four boundaries keep them there:

1. **Delivery records.** A `Batch` never contains a credential of any kind; ingestion auth is
   attached to the request in memory. `-replay-batches` output is credential-free by construction.
2. **Inspector state.** `/api/usher/state` and the SSE stream serialize `cached.Config.Pollers`.
   The `Credentials` map is a sibling field and is never in that payload.
3. **Diagnostics.** Anything journalled to the blackbox or returned as detail passes through
   `redact`, which drops any key containing `password`, `token`, `secret`, `cookie`,
   `authorization`, `apikey`, or equal to `pwd`, at any nesting depth.
4. **Telemetry.** OTLP export carries counters, gauges and histograms only; raw messages,
   credentials, addresses, site names and serials are never labels.

`TestRedaction`, the replay-export test and the telemetry test each assert a credential cannot
escape through their boundary.

## Deployment secrets are distinct from vendor credentials

The four process secrets are environment-only and each has a single purpose — none of them is a
vendor credential, and none may be reused for another role:

`GOUSHER_COLLECTOR_TOKEN` (LiveOne control plane) · `GOUSHER_RECEIVER_TOKEN` (private trial
receiver) · `GOUSHER_INSPECTOR_TOKEN` (state/SSE) · `GOUSHER_INSTANCE_KEY` (cache encryption).
`GOUSHER_METRICS_TOKEN` is a fifth, for the dedicated monitoring source. `bootstrap.yaml` contains
no secrets.

## Operational consequences

- **Rotating a vendor password** is a Clerk edit. It reaches the site within one config cycle and
  rebuilds only that reader. Do not edit anything on the collector.
- **Revoking a collector** (`PATCH /api/admin/collectors` with `disabled`) stops credential issue
  immediately, but does **not** reach a disconnected reader: it still holds a decryptable cache.
  To retire a site, pause or delete the poller and wait for the acknowledgement.
- **Losing or rotating `GOUSHER_INSTANCE_KEY` is destructive.** `OpenRuntime` fails hard on a cache
  it cannot unseal rather than discarding it, so the box needs a fresh data directory — which also
  discards the pending spool. Back the key up wherever the other deployment secrets live.
- **The volume alone does not reveal the encrypted credential cache without the key.**
  Other volume contents, such as readings and spool records, are not covered by this encryption.
- **When an operator needs to see what a site is configured with**, inspector state and the admin
  poller APIs answer it. Inspector endpoints, diagnostic logs and batch exports do not return stored vendor passwords;
  the authenticated credential endpoint above returns only the assigned vendor keys.
