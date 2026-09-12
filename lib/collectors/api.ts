import { summarizeProductionEvidence } from "./production-evidence";
import { baselineFixture } from "./baseline";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, gte, lte, desc } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/api-auth";
import { planetscaleDb as db } from "@/lib/db/planetscale";
import {
  collectors,
  managedPollers,
  devices,
  sessions,
} from "@/lib/db/planetscale/schema";
import { getDeviceCredentials } from "@/lib/secure-credentials";
import {
  settingsSchema,
  sourceSchema,
  statusSchema,
  validateSettings,
} from "./contracts";

const hash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
const response = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
class ApiError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
async function body(req: NextRequest) {
  const text = await req.text();
  if (Buffer.byteLength(text) > 256 * 1024)
    throw new ApiError("Request too large", 413);
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError("Invalid JSON");
  }
}
function failure(error: unknown) {
  if (error instanceof ApiError)
    return response({ error: error.message }, error.status);
  if (error instanceof z.ZodError)
    return response(
      {
        error: "Invalid request",
        issues: error.issues.map((i) => ({ path: i.path, message: i.message })),
      },
      400,
    );
  return response({ error: "Collector operation failed" }, 500);
}
const createSchema = z
  .object({
    collectorId: z.string().uuid(),
    deviceId: z.string().uuid(),
    source: sourceSchema,
    settings: settingsSchema,
    paused: z.boolean().default(true),
  })
  .strict();
const updateSchema = z
  .object({
    revision: z.number().int().positive(),
    settings: settingsSchema.optional(),
    paused: z.boolean().optional(),
  })
  .strict();
function checkSettings(
  source: string,
  settings: z.infer<typeof settingsSchema>,
) {
  try {
    validateSettings(source, settings);
  } catch (e) {
    throw new ApiError((e as Error).message);
  }
}

export async function adminPollers(req: NextRequest, id?: string) {
  try {
    if (!db) throw new ApiError("Database unavailable", 503);
    const auth = await requireAdmin(req);
    if (auth instanceof NextResponse) return auth;
    if (id && !z.string().uuid().safeParse(id).success)
      throw new ApiError("Invalid poller ID");
    if (req.method === "GET") {
      const rows = await db
        .select()
        .from(managedPollers)
        .where(id ? eq(managedPollers.id, id) : undefined);
      const owners = await db
        .select({
          id: collectors.id,
          name: collectors.name,
          destination: collectors.destination,
          disabled: collectors.disabled,
          lastSeenAt: collectors.lastSeenAt,
        })
        .from(collectors);
      const choices = await db
        .select({
          id: devices.id,
          name: devices.name,
          vendor: devices.vendor,
          vendorSiteId: devices.vendorSiteId,
        })
        .from(devices);
      return response({ pollers: rows, collectors: owners, devices: choices });
    }
    if (req.method === "POST" && !id) {
      const input = createSchema.parse(await body(req));
      checkSettings(input.source, input.settings);
      const row = await db.transaction(async (tx) => {
        // Serialize create/transfer requests by the existing device, including across collectors.
        const [device] = await tx
          .select()
          .from(devices)
          .where(eq(devices.id, input.deviceId))
          .for("update");
        if (!device) throw new ApiError("Device not found", 404);
        const vendor = input.source === "fronius" ? "fusher" : input.source;
        if (device.vendor !== vendor)
          throw new ApiError("Source does not match the existing device");
        const [collector] = await tx
          .select()
          .from(collectors)
          .where(eq(collectors.id, input.collectorId));
        if (!collector || collector.disabled)
          throw new ApiError("Collector unavailable", 409);
        const previous = await tx
          .select()
          .from(managedPollers)
          .where(
            and(
              eq(managedPollers.deviceId, input.deviceId),
              eq(managedPollers.source, input.source),
            ),
          );
        if (
          previous.some(
            (p) =>
              !p.deleted ||
              p.appliedRevision !== p.revision ||
              !p.status?.stopped ||
              p.status?.supervising,
          )
        )
          throw new ApiError(
            "Previous assignment must acknowledge deletion and completed supervision before transfer",
            409,
          );
        for (const previousCollectorId of new Set(
          previous.map((p) => p.collectorId),
        )) {
          const [previousCollector] = await tx
            .select({ destination: collectors.destination })
            .from(collectors)
            .where(eq(collectors.id, previousCollectorId));
          if (
            !previousCollector ||
            previousCollector.destination !== collector.destination
          )
            throw new ApiError(
              "Trial destination is immutable across assignment transfers",
              409,
            );
        }
        const [created] = await tx
          .insert(managedPollers)
          .values({ ...input, vendorSiteId: device.vendorSiteId })
          .returning();
        return created;
      });
      return response(row, 201);
    }
    if (id && (req.method === "PATCH" || req.method === "DELETE")) {
      const input = updateSchema.parse(await body(req));
      if (
        req.method === "DELETE" &&
        (input.settings || input.paused !== undefined)
      )
        throw new ApiError("Delete accepts only revision");
      const row = await db.transaction(async (tx) => {
        const [old] = await tx
          .select()
          .from(managedPollers)
          .where(eq(managedPollers.id, id))
          .for("update");
        if (!old) throw new ApiError("Poller not found", 404);
        if (old.revision !== input.revision || old.deleted)
          throw new ApiError("Revision conflict; reload the poller", 409);
        const settings = input.settings;
        if (settings) checkSettings(old.source, settings);
        const [updated] = await tx
          .update(managedPollers)
          .set({
            settings: settings ?? old.settings,
            paused: input.paused ?? old.paused,
            deleted: req.method === "DELETE",
            revision: old.revision + 1,
            updatedAt: new Date(),
          })
          .where(eq(managedPollers.id, id))
          .returning();
        return updated;
      });
      return response(row);
    }
    return response({ error: "Method not allowed" }, 405);
  } catch (e) {
    return failure(e);
  }
}

export async function adminCollectors(req: NextRequest) {
  try {
    if (!db) throw new ApiError("Database unavailable", 503);
    const auth = await requireAdmin(req);
    if (auth instanceof NextResponse) return auth;
    if (req.method === "POST") {
      const input = z
        .object({
          name: z.string().min(1).max(100),
          destination: z.string().url(),
        })
        .strict()
        .parse(await body(req));
      const u = new URL(input.destination);
      if (
        u.protocol !== "https:" ||
        u.username ||
        u.password ||
        u.search ||
        u.hash ||
        u.pathname.includes("/api/gush") ||
        u.hostname === new URL(req.url).hostname
      )
        throw new ApiError("Use a separate HTTPS trial receiver");
      const id = crypto.randomUUID();
      const token = `lo_col_${id}_${randomBytes(32).toString("hex")}`;
      await db
        .insert(collectors)
        .values({ ...input, id, tokenHash: hash(token) });
      return response({ id, token, ...input }, 201);
    }
    if (req.method === "PATCH") {
      const input = z
        .object({
          id: z.string().uuid(),
          rotate: z.boolean().optional(),
          disabled: z.boolean().optional(),
        })
        .strict()
        .parse(await body(req));
      const token = input.rotate
        ? `lo_col_${input.id}_${randomBytes(32).toString("hex")}`
        : undefined;
      const rows = await db
        .update(collectors)
        .set({
          ...(token ? { tokenHash: hash(token) } : {}),
          ...(input.disabled !== undefined ? { disabled: input.disabled } : {}),
        })
        .where(eq(collectors.id, input.id))
        .returning({ id: collectors.id });
      if (!rows.length) throw new ApiError("Collector not found", 404);
      return response({ id: input.id, token });
    }
    return response({ error: "Method not allowed" }, 405);
  } catch (e) {
    return failure(e);
  }
}

export async function collectorApi(
  req: NextRequest,
  operation: "config" | "credentials" | "status" | "baseline" | "production",
) {
  try {
    if (!db) throw new ApiError("Database unavailable", 503);
    const token =
      req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    const match = /^lo_col_([0-9a-f-]{36})_[0-9a-f]{64}$/.exec(token);
    if (!match || !z.string().uuid().safeParse(match[1]).success)
      throw new ApiError("Unauthorized", 401);
    const [collector] = await db
      .select()
      .from(collectors)
      .where(eq(collectors.id, match[1]));
    if (
      !collector ||
      collector.disabled ||
      !timingSafeEqual(
        Buffer.from(hash(token), "hex"),
        Buffer.from(collector.tokenHash, "hex"),
      )
    )
      throw new ApiError("Unauthorized", 401);
    if (operation === "config" && req.method === "GET") {
      const pollers = await db
        .select()
        .from(managedPollers)
        .where(eq(managedPollers.collectorId, collector.id));
      const revision = hash(
        JSON.stringify(pollers.map((p) => [p.id, p.revision]).sort()),
      );
      const etag = `"${revision}"`;
      if (req.headers.get("if-none-match") === etag)
        return new NextResponse(null, {
          status: 304,
          headers: { ETag: etag, "Cache-Control": "no-store" },
        });
      return NextResponse.json(
        {
          collectorId: collector.id,
          revision,
          destination: collector.destination,
          pollers: pollers.map(
            ({
              id,
              collectorId,
              deviceId,
              source,
              vendorSiteId,
              settings,
              revision,
              paused,
              deleted,
            }) => ({
              id,
              collectorId,
              deviceId,
              source,
              vendorSiteId,
              settings,
              revision,
              paused,
              deleted,
            }),
          ),
        },
        { headers: { ETag: etag, "Cache-Control": "no-store" } },
      );
    }
    if (operation === "credentials" && req.method === "GET") {
      const pollerId = z
        .string()
        .uuid()
        .parse(req.nextUrl.searchParams.get("pollerId"));
      const [p] = await db
        .select()
        .from(managedPollers)
        .where(
          and(
            eq(managedPollers.id, pollerId),
            eq(managedPollers.collectorId, collector.id),
          ),
        );
      if (!p || p.deleted) throw new ApiError("Poller not found", 404);
      const [d] = await db
        .select()
        .from(devices)
        .where(eq(devices.id, p.deviceId));
      if (!d) throw new ApiError("Device not found", 404);
      const c = await getDeviceCredentials(d.ownerUserId ?? "", d.rid);
      // Strict allow-list. In particular, never export a production ingestion apiKey.
      const keys =
        p.source === "selectronic"
          ? ["email", "password"]
          : p.source === "sigenergy"
            ? ["username", "password"]
            : [];
      const credentials: Record<string, string> = {};
      for (const key of keys)
        if (typeof c?.[key] === "string") credentials[key] = c[key];
      return response({ revision: p.revision, credentials });
    }
    if (
      (operation === "baseline" || operation === "production") &&
      req.method === "GET"
    ) {
      const pollerId = z
        .string()
        .uuid()
        .parse(req.nextUrl.searchParams.get("pollerId"));
      const start = new Date(
        z.string().datetime().parse(req.nextUrl.searchParams.get("start")),
      );
      const end = new Date(
        z.string().datetime().parse(req.nextUrl.searchParams.get("end")),
      );
      if (+end <= +start || +end - +start > 86400000)
        throw new ApiError(
          "Baseline exports require a window of at most one day",
        );
      const [p] = await db
        .select()
        .from(managedPollers)
        .where(
          and(
            eq(managedPollers.id, pollerId),
            eq(managedPollers.collectorId, collector.id),
          ),
        );
      if (!p || p.deleted) throw new ApiError("Poller not found", 404);
      if (!["selectronic", "sigenergy"].includes(p.source))
        throw new ApiError("Cloud baseline export only");
      const [d] = await db
        .select()
        .from(devices)
        .where(eq(devices.id, p.deviceId));
      if (!d) throw new ApiError("Device not found", 404);
      if (operation === "production") {
        const kind = req.nextUrl.searchParams.get("kind");
        const since = Date.parse(
          process.env.LIVEONE_TRIAL_READ_EVIDENCE_SINCE ?? "",
        );
        if (
          process.env.LIVEONE_TRIAL_READ_EVIDENCE !== "1" ||
          !Number.isFinite(since) ||
          +start < since
        )
          throw new ApiError(
            "Production read evidence coverage not configured",
            409,
          );
        if (req.nextUrl.searchParams.get("revision") !== String(p.revision))
          throw new ApiError("Stale poller revision", 409);
        if (
          !["window", "incidents"].includes(kind ?? "") ||
          +end > Date.now() - 120000 ||
          +end - +start > 3600000 ||
          (kind === "window" &&
            (+end - +start !== 900000 || +end % 900000 !== 0))
        )
          throw new ApiError(
            "Expected a completed production evidence window with two-minute ingestion allowance",
          );
        const rows = await db
          .select({ at: sessions.createdAt, response: sessions.response })
          .from(sessions)
          .where(
            and(
              eq(sessions.deviceRid, d.rid),
              eq(sessions.cause, "CRON"),
              gte(sessions.createdAt, start),
              lte(sessions.createdAt, end),
            ),
          )
          .orderBy(desc(sessions.createdAt))
          .limit(501);
        if (rows.length > 500)
          throw new ApiError("Production evidence window too large", 413);
        let evidence;
        try {
          evidence = summarizeProductionEvidence(
            p.source,
            rows,
            start,
            end,
            kind === "incidents",
          );
        } catch {
          throw new ApiError(
            "Production evidence incomplete or unavailable",
            409,
          );
        }
        return response({
          role: "production",
          siteId: p.vendorSiteId,
          ...(kind === "window"
            ? { windowEnd: end.toISOString(), metrics: evidence.metrics }
            : { incidents: evidence.incidents }),
        });
      }
      const rows = await db
        .select({
          id: sessions.id,
          at: sessions.createdAt,
          response: sessions.response,
        })
        .from(sessions)
        .where(
          and(
            eq(sessions.deviceRid, d.rid),
            gte(sessions.createdAt, start),
            lte(sessions.createdAt, end),
            eq(sessions.successful, true),
          ),
        )
        .orderBy(desc(sessions.createdAt))
        .limit(501);
      if (rows.length > 500)
        throw new ApiError(
          "Window contains more than 500 samples; use a smaller window",
          413,
        );
      const fixtures = rows
        .reverse()
        .map((row) =>
          baselineFixture(p.source, row.response, row.at, p.id, p.revision),
        );
      return response({
        fixtures: fixtures.filter((f) => f !== null),
        unmatched: fixtures.filter((f) => f === null).length,
        revisionNote:
          "Export assignment revision; production sessions predate managed revisions.",
      });
    }
    if (operation === "status" && req.method === "POST") {
      const input = z
        .object({ pollers: z.array(statusSchema).max(500) })
        .strict()
        .parse(await body(req));
      await db.transaction(async (tx) => {
        for (const status of input.pollers) {
          const [p] = await tx
            .select()
            .from(managedPollers)
            .where(
              and(
                eq(managedPollers.id, status.id),
                eq(managedPollers.collectorId, collector.id),
              ),
            )
            .for("update");
          if (
            !p ||
            status.appliedRevision > p.revision ||
            status.appliedRevision < p.appliedRevision
          )
            throw new ApiError("Invalid applied revision", 409);
          if (
            p.deleted &&
            status.appliedRevision === p.revision &&
            (!status.stopped || status.supervising)
          )
            throw new ApiError("Deletion still requires shutdown", 409);
          await tx
            .update(managedPollers)
            .set({ appliedRevision: status.appliedRevision, status })
            .where(eq(managedPollers.id, p.id));
        }
        await tx
          .update(collectors)
          .set({ lastSeenAt: new Date() })
          .where(eq(collectors.id, collector.id));
      });
      return response({ ok: true });
    }
    return response({ error: "Method not allowed" }, 405);
  } catch (e) {
    return failure(e);
  }
}
