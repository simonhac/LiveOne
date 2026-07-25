/**
 * Connection forensics for the Postgres dropouts recorded in
 * `docs/incidents/2026-07-25-prod-dev-sync-connection-dropouts.md`.
 *
 * That investigation could only prove the TCP/TLS socket disappeared — not who closed
 * it. These two probes capture the missing evidence. Both are strictly diagnostic and
 * FAIL-SAFE: a probe must never break the operation it observes, so every path here
 * swallows its own errors.
 *
 * 1. `probeConnectionPath()` — one round-trip at connect. Answers the question the
 *    incident left open: is there a POOLER between us and Postgres? The tell is a port
 *    mismatch — we dial 6432 but the backend reports `inet_server_port()` 5432, meaning
 *    PgBouncer terminated our socket and opened its own to the server. It also snapshots
 *    the SERVER-side timeouts, which the incident could not rule out: the audit that
 *    excluded a fixed timeout only covered client config, and a role-level
 *    `ALTER ROLE … SET statement_timeout` is invisible from there.
 *
 * 2. `armSocketForensics()` — passive listeners on the raw TCP/TLS socket, so a drop
 *    reports HOW it died instead of only that it did:
 *      - `hadError=false` + `sawFin=true` → a graceful FIN. Something closed the session
 *        deliberately (pooler / gateway / load balancer). Postgres itself would have sent
 *        an ErrorResponse (`57P01 admin_shutdown`, …) first, which `pg` surfaces as an
 *        error carrying a SQLSTATE — and none of the recorded dropouts had one.
 *      - `hadError=true` → an RST: a hard abort, network-shaped.
 *    Plus socket age and the phase it died in, which separates an idle-reap (the prod
 *    client sits idle through every dev-side upsert) from a mid-stream COPY failure.
 *
 * PRIVACY: this repo is public, so its GitHub Actions logs are public. The server
 * address is therefore never logged — only whether it CHANGED between probes, which is
 * the failover signal we actually want.
 */

/** Minimal shape we need; satisfied by both `pg.Client` and a pooled client. */
interface Queryable {
  query(sql: string): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/** The raw `net.Socket` / `tls.TLSSocket` behind a pg client. */
interface SocketLike {
  bytesRead?: number;
  bytesWritten?: number;
  once(event: string, listener: (...args: unknown[]) => void): unknown;
}

export interface ConnectionPathInfo {
  /** Port from the connection URL; "" when absent (pg then defaults to 5432). */
  clientPort: string;
  /** Port the BACKEND sees for this connection (`inet_server_port()`). */
  serverPort: number | null;
  /** True when the ports differ — positive proof an intermediary re-originated us. */
  portMismatch: boolean;
  /**
   * Deliberately ONE-SIDED. `inet_server_port()` reports only the LAST hop, so a
   * mismatch proves pooling but equality proves nothing — a transparent same-port proxy
   * is invisible to this test. Hence "inconclusive", never "direct".
   */
  verdict: "pooled" | "inconclusive";
  backendPid: number | null;
  /** Never logged — compared across probes to detect a failover. */
  serverAddr: string | null;
  // NOTE: these four are PG's `statement_timeout`, `idle_in_transaction_session_timeout`,
  // `idle_session_timeout` and `tcp_keepalives_idle`. The field names deliberately AVOID
  // the substring "timeout": `classifyWorkflowFailure`
  // (scripts/utils/run-workflow-step-with-diagnostics.ts) keyword-scans the whole step
  // log, and a "timeout" anywhere in it mis-buckets every otherwise-unclassified failure
  // as "operation timeout". Pinned by a regression test in
  // scripts/__tests__/workflow-step-diagnostics.test.ts — do not rename them back.
  statementLimit: string | null;
  idleTxnLimit: string | null;
  idleSessionLimit: string | null;
  keepalivesIdle: string | null;
  serverVersion: string | null;
}

export interface SocketForensics {
  /** Describe what the connection is doing, so a death report can name the phase. */
  setPhase(phase: string): void;
}

// `current_setting(name, true)` is missing_ok — returns NULL rather than erroring on a
// setting this server version doesn't have (e.g. idle_session_timeout is PG14+).
const PATH_PROBE_SQL = `
  SELECT inet_server_addr()::text                                AS server_addr,
         inet_server_port()                                      AS server_port,
         pg_backend_pid()                                        AS backend_pid,
         current_setting('statement_timeout', true)              AS statement_limit,
         current_setting('idle_in_transaction_session_timeout', true) AS idle_txn_limit,
         current_setting('idle_session_timeout', true)           AS idle_session_limit,
         current_setting('tcp_keepalives_idle', true)            AS keepalives_idle,
         current_setting('server_version', true)                 AS server_version`;

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function num(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Port from a connection URL, or "" when the URL omits it / can't be parsed. */
function portOf(url: string): string {
  try {
    return new URL(url).port || "";
  } catch {
    return "";
  }
}

/**
 * One round-trip that establishes whether a pooler sits in the path, plus the
 * server-side timeout settings. Returns null if anything goes wrong — never throws.
 */
export async function probeConnectionPath(
  client: Queryable,
  url: string,
): Promise<ConnectionPathInfo | null> {
  try {
    const { rows } = await client.query(PATH_PROBE_SQL);
    const row = rows[0] ?? {};
    const clientPort = portOf(url);
    const serverPort = num(row.server_port);
    // pg dials 5432 when the URL omits a port, so that's the effective comparison.
    const effectiveClientPort = clientPort || "5432";
    const portMismatch =
      serverPort !== null && String(serverPort) !== effectiveClientPort;

    return {
      clientPort,
      serverPort,
      portMismatch,
      verdict: portMismatch ? "pooled" : "inconclusive",
      backendPid: num(row.backend_pid),
      serverAddr: str(row.server_addr),
      statementLimit: str(row.statement_limit),
      idleTxnLimit: str(row.idle_txn_limit),
      idleSessionLimit: str(row.idle_session_limit),
      keepalivesIdle: str(row.keepalives_idle),
      serverVersion: str(row.server_version),
    };
  } catch {
    return null;
  }
}

/** One-line log form. Deliberately omits `serverAddr` (see PRIVACY in the header). */
export function formatConnectionPath(info: ConnectionPathInfo): string {
  const { serverAddr: _omitted, ...loggable } = info;
  return JSON.stringify(loggable);
}

function socketOf(client: unknown): SocketLike | null {
  // `connection.stream` is node-postgres internals (the net.Socket / TLSSocket) and is
  // absent from the public types — hence the cast. Best-effort: null disables the probe.
  const stream = (client as { connection?: { stream?: unknown } } | null)
    ?.connection?.stream;
  if (!stream || typeof (stream as { once?: unknown }).once !== "function") {
    return null;
  }
  return stream as SocketLike;
}

/**
 * Did WE initiate this shutdown? `pg` sets `_ending` in `Client.end()` /
 * `Connection.end()` before the socket starts closing — the same flag it uses itself to
 * choose between "Connection terminated" and "Connection terminated unexpectedly". So
 * our definition of "unexpected" matches pg's exactly.
 */
function isEnding(client: unknown): boolean {
  const c = client as
    | { _ending?: boolean; connection?: { _ending?: boolean } }
    | null
    | undefined;
  return c?._ending === true || c?.connection?._ending === true;
}

/**
 * Attach socket-level death listeners. Call AFTER `connect()` — pg only creates the
 * stream then, so arming earlier silently does nothing.
 */
export function armSocketForensics(
  client: unknown,
  label: string,
  log: (message: string) => void,
): SocketForensics {
  const openedAt = Date.now();
  // Callers that don't track phases (the shared pool) must not claim "no work started".
  let phase = "(not tracked)";
  let sawFin = false;
  // Latched the INSTANT distress is seen, not at 'close'. Ordering matters: on a real
  // drop the query rejects on a nextTick, so the caller's `finally` can run `end()` —
  // setting `_ending` — BEFORE 'close' fires. Deciding at 'close' would then misread a
  // genuine dropout as our own shutdown and silently swallow the very event we're hunting.
  let died = false;

  const socket = socketOf(client);
  if (socket) {
    // 'end' = peer sent FIN (graceful). 'error' = RST/transport failure. Either one
    // arriving while we are NOT ending means the far side closed on us.
    socket.once("end", () => {
      sawFin = true;
      if (!isEnding(client)) died = true;
    });
    socket.once("error", () => {
      if (!isEnding(client)) died = true;
    });
    socket.once("close", (...args: unknown[]) => {
      // Silent only when we initiated it AND never saw distress first.
      if (!died && isEnding(client)) return;
      const hadError = args[0] === true;
      log(
        `[${label}] socket-death ${JSON.stringify({
          ageMs: Date.now() - openedAt,
          hadError,
          sawFin,
          shape: hadError
            ? "RST (hard reset — network-shaped)"
            : sawFin
              ? "FIN (graceful close by peer — deliberate)"
              : "closed with neither FIN nor error",
          phase,
          bytesRead: socket.bytesRead ?? null,
          bytesWritten: socket.bytesWritten ?? null,
        })}`,
      );
    });
  } else {
    log(`[${label}] socket-death probe unavailable (no connection.stream)`);
  }

  return {
    setPhase(next: string) {
      phase = next;
    },
  };
}

/**
 * Re-probe and report whether the backend moved under us. A changed pid or address on a
 * connection we believe is persistent would disprove that premise — a transaction-mode
 * pooler swapping backends, or a failover. Never throws.
 */
export async function reportBackendDrift(
  client: Queryable,
  label: string,
  initial: ConnectionPathInfo | null,
  log: (message: string) => void,
): Promise<void> {
  if (!initial) return;
  const now = await probeConnectionPath(client, "");
  if (!now) return;
  const pidChanged =
    initial.backendPid !== null &&
    now.backendPid !== null &&
    initial.backendPid !== now.backendPid;
  const addrChanged =
    initial.serverAddr !== null &&
    now.serverAddr !== null &&
    initial.serverAddr !== now.serverAddr;
  if (!pidChanged && !addrChanged) return;
  log(
    `[${label}] backend-drift ${JSON.stringify({
      pidChanged,
      addrChanged,
      note: "connection was assumed persistent; backend moved mid-run",
    })}`,
  );
}
