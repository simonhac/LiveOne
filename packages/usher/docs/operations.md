# usher — operations

> **Status:** current. The model behind these symptoms is in [architecture.md](architecture.md);
> deploy procedures are in [deploy-fly.md](deploy-fly.md) and [deploy-pi.md](deploy-pi.md).

Commands below are given for both deploy targets. On the **Fly hub** they run through
`fly ssh console -a liveone-flyhub -C "…"`; on a **Pi** they are plain shell over SSH, with
`journalctl -u usher` in place of `fly logs`.

## Is it alive?

Three signals, in increasing order of trustworthiness:

1. **The inspector** — `https://usher.liveone.energy` (Cloudflare Access SSO) on the Fly hub, or
   `http://<pi>:3000` if you exposed it locally. Shows each source's last tick, its live snapshot,
   and store health.
2. **Point readings still arriving** in LiveOne for the relevant devices.
3. **A growing blackbox journal.** This is the real liveness signal, because it records what was
   _collected_ — it stays true even when the receiver is down.

```bash
# Fly
fly ssh console -a liveone-flyhub -C "wg show wg0"                                   # both peers handshaking?
fly ssh console -a liveone-flyhub -C "df -h /data"                                   # volume headroom
fly ssh console -a liveone-flyhub -C "wc -l /data/usher/blackbox/$(date -u +%F).jsonl"  # journal growing?
fly ssh console -a liveone-flyhub -C "ls -la /data/usher/spool"                       # should be empty

# Pi
systemctl status usher
journalctl -u usher -f
wc -l /var/lib/usher/blackbox/$(date -u +%F).jsonl
```

## Store triage

The operational half of the [durability model](architecture.md#the-durability-model). Symptom →
meaning → action:

| symptom                                                 | what it means                                                                   | what to do                                                                                                                                 |
| ------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Spool non-empty and growing**                         | The receiver is down or unreachable. Collection is fine; nothing is being lost. | Nothing. It drains itself on the next successful push. `spool.oldestAt` in the inspector shows how far back the outage goes.               |
| **Spool non-empty and static**                          | Pushes are still failing, or batches are being rejected.                        | Check the logs for `permanently rejected` — that is a 4xx (bad key, site or body) and a redeploy will not fix it.                          |
| `spool: over 75% of disk — DROPPED oldest unsent batch` | The outage outlasted the buffer.                                                | Those batches are gone from the queue but **still in the blackbox journal**. Recovery is a manual replay from the journal, not a re-drain. |
| `blackbox: … journaling DISABLED`                       | The store directory is unwritable.                                              | Collection continues. The 5-minute `maintain()` re-enables it automatically once the disk recovers — check `df -h /data` for the cause.    |
| `blackbox: LOW DISK` (25% / 15%)                        | Archives start being GC'd oldest-first at 10% free.                             | Usually the spool holding an outage backlog, not journal growth. Check the spool first.                                                    |
| Deploy fails on the mount                               | The Fly volume does not exist.                                                  | `fly volumes create usher_data --size 1 --region syd -a liveone-flyhub`                                                                    |

### Reading the store by hand

One journal line is one collected batch:

```json
{"at":"…","siteId":"…","sessionLabel":"…","measurementTime":"…","count":8,"readings":[…]}
```

A spool file is the same batch, ready to replay: it becomes a valid `POST /api/gush` body by adding
`vendorSiteId`, `apiKey` and `action: "store"`. Neither store persists the API key — it is re-attached
from the environment at send time.

```bash
# last 3 journal entries, readable
fly ssh console -a liveone-flyhub -C "tail -3 /data/usher/blackbox/$(date -u +%F).jsonl"
# how far back does the backlog go?
fly ssh console -a liveone-flyhub -C "ls /data/usher/spool | head -1"    # filename starts with spooledAt ms
```

## Gotchas

Each of these has already cost debugging time.

- **The Fronius inverters do not answer ICMP.** The DeepSea controller does. A failed `ping` to an
  inverter is _not_ evidence of a fault — the real signal is a fresh journal entry or a `stored N
readings (200)` log line.
- **`fly logs --no-tail` returns a stale buffered window.** Stream `fly logs` (bounded) to see
  current activity; a large backlog also replays slowly.
- **The first 1–2 fusher ticks after a restart log `no readings this tick (all n/a)`** while the
  inverters are still being discovered. Normal. Confirm recovery on the following tick.
- **The Modbus idle-socket trap.** At a 5-minute poll interval the persistent Modbus/TCP socket is
  silently dropped during the idle gap, and `modbus-serial`'s read timeout does **not** fire on the
  dead socket — the next read hangs forever and freezes the whole loop. Symptom: one
  boundary-aligned poll, then silence. Two mitigations are in place and both must stay: musher
  reconnects fresh each tick (`read()` closes in `finally`), and the run loop applies a per-tick hard
  timeout plus `source.reset()`.
- **`--ha=false` is required on every Fly deploy.** A single machine with a single volume cannot roll.

## DeepSea diagnostics

`MUSHER_DIAGNOSTICS=1` captures the **full** DeepSea register dump — all ~94 registers with decoded
value, raw words and sentinel reason — on every poll, one JSON line per poll.

- Written to `<dataDir>/diag/YYYY-MM-DD.jsonl` (`/data/usher/diag/` on the hub), gzipped on the day
  roll, and also logged to stdout tagged `[musher-diag]`.
- **The diag directory is capped at 100 MB**, oldest purged first, swept at boot and roughly hourly;
  the day being written is never purged. At the hub's temporary 15 s poll cadence that is ~52 MB/day
  uncompressed but only ~0.5 MB/day rolled — these records are near-identical, so gzip measures
  ~106:1 — leaving roughly three months of history. Still a temporary debugging aid: turn it off and
  prune the directory when the investigation ends.
- It is declared in `fly.toml` `[env]`, deliberately visible in the repo — an earlier out-of-band
  setting meant nobody knew capture was off, and a generator run was lost. A `fly secrets set` value
  of the same name would override it.
- `MUSHER_DIAG_POSTRUN_SECONDS` (default 3600, set to 3600 on the hub) holds the fast cadence for
  that long after a run ends, giving a fine-resolution cool-down baseline. It does **not** gate
  capture. It replaced `MUSHER_DIAG_POSTRUN_TICKS`, a tick COUNT — which silently rescaled itself
  whenever the poll cadence changed.

**Capture is no longer run-gated.** It used to be, so the first record was always of an
already-running machine and the journal could never explain what _started_ a generator. Since
2026-07-28 every poll is captured, idle included, which is what makes the pre-start state
observable at all.

**Poll ≠ push.** `pollSec` is the read (and therefore journal) cadence; `pushSec`/`activePushSec`
are what reaches LiveOne. On the hub that is 15 s poll against 300 s/60 s push, so the diagnostic
resolution costs disk but does not multiply what the receiver stores. A start or stop delivers
immediately regardless of the push cadence.

## Related

- Register map and decode rules for the DeepSea controller: [`scripts/modbus-registers.md`](../../../scripts/modbus-registers.md)
  (ground truth is `clients/dse-client.ts`).
