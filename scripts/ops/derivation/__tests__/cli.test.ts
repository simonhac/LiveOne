/**
 * The `derivation` domain's flag contract, asserted through the pure parser.
 *
 * `parse()` is importable here precisely because the domain module has no entrypoint (the
 * `scripts/ops/find` suite does the same), so the spec can be exercised without a network, a token,
 * or a running server. Handlers are not unit-tested — their HTTP behaviour is covered by
 * `lib/cli-kit/__tests__/http.test.ts` — so what is worth pinning here is the shape a typo lands in:
 * every one of these is a refusal that would otherwise become a confusing 4xx from prod, or worse, a
 * silently wrong write.
 */
import { describe, it, expect } from "@jest/globals";
import { CliFailure, EXIT, failWith, parse, type Tty } from "@/lib/cli/cli";
import type { ApiSession } from "@/lib/cli-kit/api-session";
import { derivationCommand } from "../cli";
import { DELETE_ERRORS, WRITE_ERRORS } from "../handlers";
import { resolveBoundaryPoint, type WireDerivation } from "../model";

const TTY: Tty = { stdoutIsTTY: true, stdinIsTTY: true };

/** Parse under the real ancestry, so error messages name a runnable command. */
const at = (argv: string[]) => parse(derivationCommand, argv, TTY, ["liveone"]);

const failure = (argv: string[]) => {
  const r = at(argv);
  if (r.ok) throw new Error("expected a usage error, got ok");
  return JSON.stringify(r.error);
};

const success = (argv: string[]) => {
  const r = at(argv);
  if (!r.ok) throw new Error(`expected ok, got: ${r.error.what}`);
  return r;
};

describe("the write gate", () => {
  // The harness installs --apply/--dry-run/--yes from `mutates`, but only on the verbs that declare
  // it. A read verb that grew the flags would be advertising a gate it does not honour.
  it.each(["create", "set", "enable", "disable", "delete", "recompute"])(
    "%s is dry by default and offers --apply",
    (verb) => {
      const args =
        verb === "create"
          ? ["create", "kutis", "--role=ev", "--signal=load.ev/power"]
          : verb === "set"
            ? ["set", "ev", "--delay-off=900"]
            : [verb, "ev"];
      expect(success(args).dryRun).toBe(true);
      expect(success([...args, "--apply"]).dryRun).toBe(false);
    },
  );

  it.each(["list", "intervals"])("%s has no write flags at all", (verb) => {
    const args = verb === "list" ? ["list"] : ["intervals", "ev"];
    expect(failure([...args, "--apply"])).toMatch(/apply/i);
  });
});

describe("addressing", () => {
  // 🛑 The whole point of the increment: a derivation is addressed by identity, and the area is
  // gone from every verb. A stray `<area>` positional would now be read as the DERIVATION ref and
  // resolve to something wrong rather than failing, so the arity is the assertion.
  it("takes no area: list is bare, and every item verb takes the derivation alone", () => {
    expect(success(["list"]).args).toEqual([]);
    expect(success(["intervals", "ev"]).args).toEqual(["ev"]);
    expect(failure(["intervals", "kutis", "ev"])).toBeTruthy();
    expect(failure(["enable", "kutis", "ev"])).toBeTruthy();
  });

  it("takes an optional positional scope on list", () => {
    expect(success(["list", "daylesford"]).args).toEqual(["daylesford"]);
  });

  it("offers --device/--area as narrowing on every verb that resolves a derivation", () => {
    for (const verb of [
      ["list"],
      ["set", "ev", "--delay-off=900"],
      ["enable", "ev"],
      ["disable", "ev"],
      ["delete", "ev"],
      ["recompute", "ev"],
      ["intervals", "ev"],
    ]) {
      expect(success([...verb, "--device=kutis"]).flags.device).toBe("kutis");
      // Both halves, because the name of this test claims both: `--area` narrows through a
      // different server leg (member devices of an area) and was previously unasserted.
      expect(success([...verb, "--area=kinkora"]).flags.area).toBe("kinkora");
      const both = success([...verb, "--device=kutis", "--area=kinkora"]);
      expect([both.flags.device, both.flags.area]).toEqual([
        "kutis",
        "kinkora",
      ]);
    }
  });

  it("requires the device on create — it is what the detector is about", () => {
    expect(failure(["create", "--role=ev", "--signal=load.ev/power"])).toMatch(
      /device/i,
    );
  });
});

describe("create", () => {
  it("refuses a role that is not trackable", () => {
    // `solar` is a real role; it is just not one a run detector can be built for. The enum catches
    // it here rather than letting the server 422 after a round trip.
    expect(
      failure([
        "create",
        "kutis",
        "--role=solar",
        "--signal=load.ev/power",
        "--upper=100",
      ]),
    ).toMatch(/role/i);
  });

  it("refuses an unknown kind", () => {
    expect(failure(["create", "kutis", "--kind=magic"])).toMatch(/kind/i);
  });

  it("accepts a path, a qualified path or a pt_ id for --signal", () => {
    // Both bare forms parse; which one resolves is the handler's business (and the server's). The
    // qualified form is what replaced the old area fan-out, so it must survive the parser intact.
    for (const signal of [
      "load.ev/power",
      "daylesford:load.ev/power",
      "pt_35h177gqtrb93b3s7n5y6t65rv",
    ])
      expect(
        success(["create", "kutis", "--role=ev", `--signal=${signal}`]).flags
          .signal,
      ).toBe(signal);
  });

  it("takes the thresholds as numbers, not strings", () => {
    // `--upper=100` reaching the body as "100" would be sent as a string and 422'd by
    // `toRunDetectorParams`, which requires `typeof v === "number"`.
    const r = success([
      "create",
      "kutis",
      "--role=ev",
      "--signal=load.ev/power",
      "--upper=100",
      "--delay-off=300",
    ]);
    expect(r.flags.upper).toBe(100);
    expect(r.flags.delayOff).toBe(300);
  });

  it("exposes the sparse knobs as absent, not as zeros", () => {
    // 🛑 The sparse contract: an omitted knob must arrive at the handler as `undefined` so it is
    // left out of `params` and inherits the role default. A `default: 0` on any of these flags
    // would silently pin every detector's hysteresis to zero forever.
    const r = success([
      "create",
      "kutis",
      "--role=ev",
      "--signal=load.ev/power",
    ]);
    for (const k of ["upper", "lower", "hysteresis", "delayOn", "delayOff"])
      expect(r.flags[k]).toBeUndefined();
  });
});

describe("set", () => {
  it("collects repeated --unset", () => {
    const r = success(["set", "ev", "--unset=hysteresis", "--unset=delayOn"]);
    expect(r.flags.unset).toEqual(["hysteresis", "delayOn"]);
  });

  it("refuses an --unset that is not a knob", () => {
    // `signalKind` IS a params key, but it is not a threshold knob and clearing it would leave the
    // detector with no signal kind at all.
    expect(failure(["set", "ev", "--unset=signalKind"])).toMatch(/unset/i);
  });

  it("shares its knob flags with create, so the two cannot disagree", () => {
    // Both verbs read the same KNOBS table; this pins that they accept the same spellings.
    for (const flag of [
      "--upper=100",
      "--lower=50",
      "--hysteresis=10",
      "--delay-on=30",
      "--delay-off=900",
    ]) {
      expect(success(["set", "ev", flag]).ok).toBe(true);
      expect(
        success([
          "create",
          "kutis",
          "--role=ev",
          "--signal=load.ev/power",
          flag,
        ]).ok,
      ).toBe(true);
    }
  });

  it("exposes the boundary slot, both to set and to clear", () => {
    // `boundary` was write-only until PR 3 projected it back onto the wire; exposing a flag whose
    // effect could not be read back is exactly what that ordering existed to prevent.
    expect(
      success(["set", "ev", "--boundary=load.hws/power"]).flags.boundary,
    ).toBe("load.hws/power");
    expect(success(["set", "ev", "--clear-boundary"]).flags.clearBoundary).toBe(
      true,
    );
    // Only `set` has it — `create` does not, because `ensureRunDetector` writes no boundary.
    expect(
      failure(["create", "kutis", "--role=ev", "--boundary=load.hws/power"]),
    ).toMatch(/boundary/i);
  });
});

describe("delete", () => {
  it("takes the derivation alone, and offers --force", () => {
    expect(success(["delete", "ev"]).args).toEqual(["ev"]);
    expect(success(["delete", "ev", "--force"]).flags.force).toBe(true);
  });

  // 🛑 The two 409s mean opposite things about what to do next, and only one is waivable. The
  // shared handler in lib/cli-kit/http.ts answers any 409 with "pick a different slug", which is
  // written for an alias collision and would discard `detail.dependents` — the only part of a
  // relied-upon refusal worth reading.
  it("renders the dependents of a relied-upon refusal", () => {
    const why = DELETE_ERRORS[409].why({
      error: "That derivation is still relied upon by 2 thing(s)",
      detail: {
        code: "relied-upon",
        dependents: [
          {
            kind: "intervals",
            id: "477",
            name: "2025-10-04 … 2026-09-01",
            via: "derived_intervals.derivation_id (ON DELETE CASCADE)",
            effect: "cascade-deleted",
            fix: "export them, or accept the loss",
          },
          {
            kind: "automation",
            id: "au_2b",
            name: null,
            via: "automations.trigger → source.derivationId",
            effect: "dangles",
            fix: "re-point or delete that rule",
          },
        ],
      },
    });
    expect(why).toContain("intervals 2025-10-04 … 2026-09-01 (477)");
    expect(why).toContain("cascade-deleted");
    // An unnamed dependent still renders, without an empty gap where the name would be.
    expect(why).toContain(
      "automation (au_2b) — via automations.trigger → source.derivationId",
    );
    expect(why).not.toContain("slug");
  });

  it("passes the unwaivable interlock through with its fix, and never calls it forceable", () => {
    const why = DELETE_ERRORS[409].why({
      error: "That derivation is still enabled",
      detail: {
        code: "derivation-enabled",
        fix: "PATCH { enabled: false } first, watch it stop, then delete. ?force=true does not waive this.",
      },
    });
    expect(why).toContain("still enabled");
    expect(why).toContain("does not waive this");
    expect(DELETE_ERRORS[409].next).toMatch(/does NOT waive/);
    expect(DELETE_ERRORS[409].next).toContain("nothing was deleted");
  });

  it("inherits the shared write vocabulary rather than restating it", () => {
    // The 403/422 renderers are asserted once, below; what matters here is that `delete` gets them
    // — a hand-rolled `errors` map on this verb would drift from the others silently.
    expect(DELETE_ERRORS[403]).toBe(WRITE_ERRORS[403]);
    expect(DELETE_ERRORS[422]).toBe(WRITE_ERRORS[422]);
  });
});

describe("refusals every write verb shares", () => {
  // 🛑 Without an explicit 422 override, `apiFetch` throws `DocInvalidError` — written for a
  // dashboard-doc rejection, it reads `errors`/`warnings` and DISCARDS `body.error`. Every 422 this
  // domain answers with is a plain `{error}`, so the operator would have been told "the document
  // was rejected by the server's validator" and nothing about what was actually wrong.
  it("quotes the server's own words on a 422", () => {
    expect(
      WRITE_ERRORS[422].why({
        error:
          "boundaryPointUid applies only to run-detector derivations (this one is 'hws-model')",
      }),
    ).toContain("applies only to run-detector");
    expect(WRITE_ERRORS[422].next).toContain("nothing was written");
  });

  it("names the devices a 403 refused on, and counts the ones it may not name", () => {
    const why = WRITE_ERRORS[403].why({
      error: "Write access required on every device this derivation touches",
      detail: {
        code: "device-write-required",
        devices: [{ id: "dv_01k9", name: "Daylesford Generator" }],
        hiddenDevices: 1,
      },
    });
    expect(why).toContain("dv_01k9  Daylesford Generator");
    expect(why).toContain("1 device(s) that are not yours to see");
    // The shared 403 advises `--via=db`, a transport this domain does not have.
    expect(WRITE_ERRORS[403].next).not.toMatch(/via=db/);
  });
});

describe("recompute", () => {
  it("requires the derivation — there is no unscoped form", () => {
    // The whole reason this verb posts to `…/derivations/{dx_}/recompute` rather than the cron.
    expect(failure(["recompute"])).toMatch(/derivation/i);
  });

  it("defaults to regenerate and refuses an unknown action", () => {
    expect(success(["recompute", "ev"]).flags.action).toBe("regenerate");
    expect(failure(["recompute", "ev", "--action=rebuild"])).toMatch(/action/i);
  });

  it("refuses a malformed date rather than sending it", () => {
    expect(failure(["recompute", "ev", "--start=6 July"])).toMatch(/start/i);
    expect(failure(["recompute", "ev", "--start=2026-13-01"])).toMatch(
      /start/i,
    );
  });

  it("accepts a whole window", () => {
    const r = success([
      "recompute",
      "ev",
      "--start=2026-07-06",
      "--end=2026-09-01",
      "--apply",
    ]);
    expect(r.flags.start).toBe("2026-07-06");
    expect(r.flags.end).toBe("2026-09-01");
  });
});

describe("arity", () => {
  it("refuses a second positional on the item verbs", () => {
    expect(failure(["intervals", "ev", "extra"])).toBeTruthy();
    expect(failure(["list", "daylesford", "extra"])).toBeTruthy();
  });

  // 🛑 The absent-vs-EMPTY half of the boolean trap: `--device=` parses to "", which is falsy, so a
  // truthiness test would wave `list A --device= --area=B` through and then drop both flags.
  it("treats an empty narrowing flag as supplied, not as absent", () => {
    const r = success(["list", "kutis", "--device="]);
    expect(r.flags.device).toBe("");
  });

  it("suggests the right verb for a near miss", () => {
    // The harness's Levenshtein hint; worth asserting once so a renamed verb keeps it.
    expect(failure(["recompute-all"])).toMatch(/recompute/);
  });
});

describe("resolveBoundaryPoint: a 404 is invisibility, anything else is itself", () => {
  /**
   * A derivation touching one device whose point inventory this caller cannot read — the case that
   * exists because `/api/v4/devices` serves the ACTIVE owned∪granted∪public set and does not widen
   * for admins, while `lib/derivations/scope.ts` authorizes against every device in the wiring.
   */
  const row = {
    id: "dx_1",
    kind: "run-detector",
    role: "generator",
    name: "generator runs",
    enabled: true,
    output: "intervals",
    outputPointId: null,
    params: {},
    sourcePoints: { signal: "pt_1", energy: null, boundary: null },
    devices: ["dv_hidden"],
  } as WireDerivation;

  /**
   * A session whose per-device read fails. `thrown` decides how.
   *
   * 🛑 The 404 leg builds its error by INVOKING the caller's own `errors[404]` override, exactly as
   * `apiFetch` does — so the test pins the contract (a 404 is classified by the override the caller
   * supplied) without hard-coding the sentinel string, which would pass just as happily if the two
   * copies drifted apart.
   */
  const session = (thrown: "404" | "upstream"): ApiSession =>
    ({
      origin: "https://example.test",
      token: "lo_cli_x",
      get: async (
        _path: string,
        init?: {
          errors?: Record<
            number,
            {
              exit: number;
              what: string;
              why: (b: Record<string, unknown>) => string;
              next: string;
            }
          >;
        },
      ) => {
        if (thrown === "404") {
          const o = init?.errors?.[404];
          if (!o)
            throw new Error(
              "no 404 override was passed — the sentinel cannot work",
            );
          throw failWith(o.exit, o.what, o.why({}), o.next);
        }
        throw failWith(
          EXIT.UPSTREAM,
          "https://example.test/api/v4/devices/dv_hidden answered 500",
          "unexpected server error",
          "retry; if it persists the deployment is degraded",
        );
      },
    }) as unknown as ApiSession;

  it("refuses with an actionable message, and names the pt_ escape hatch, on a 404", async () => {
    await expect(
      resolveBoundaryPoint(session("404"), row, "load.hws/power", new Map()),
    ).rejects.toMatchObject({
      detail: {
        code: EXIT.USAGE,
        // Named, so the operator knows WHICH device blocked it…
        what: expect.stringContaining("dv_hidden"),
        // …and told the one form that needs no resolution at all.
        next: expect.stringContaining("pt_"),
      },
    });
  });

  it("lets a 500 through as a 500, rather than blaming device visibility", async () => {
    // 🛑 The regression this guards: a bare `catch` here reported every failure — a dead socket, a
    // 401, an outage — as "that device is not in your inventory", and downgraded the exit code to
    // USAGE(2) while sending the operator after a pt_ id to work around an outage.
    const err = await resolveBoundaryPoint(
      session("upstream"),
      row,
      "load.hws/power",
      new Map(),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(CliFailure);
    expect((err as CliFailure).detail.code).toBe(EXIT.UPSTREAM);
    expect((err as CliFailure).detail.what).toContain("answered 500");
    expect((err as CliFailure).detail.what).not.toMatch(/inventory/i);
  });
});
