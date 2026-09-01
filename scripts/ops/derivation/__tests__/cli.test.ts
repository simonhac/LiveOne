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
import { parse, type Tty } from "@/lib/cli/cli";
import { derivationCommand } from "../cli";

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
  it.each(["create", "set", "enable", "disable", "recompute"])(
    "%s is dry by default and offers --apply",
    (verb) => {
      const args =
        verb === "create"
          ? ["create", "kutis", "--role=ev", "--signal=load.ev/power"]
          : verb === "set"
            ? ["set", "kutis", "ev", "--delay-off=900"]
            : [verb, "kutis", "ev"];
      expect(success(args).dryRun).toBe(true);
      expect(success([...args, "--apply"]).dryRun).toBe(false);
    },
  );

  it.each(["list", "intervals"])("%s has no write flags at all", (verb) => {
    const args =
      verb === "list" ? ["list", "kutis"] : ["intervals", "kutis", "ev"];
    expect(failure([...args, "--apply"])).toMatch(/apply/i);
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

  it("accepts a logical path or a pt_ id for --signal", () => {
    // Both forms parse; which one resolves is the handler's business (and the server's).
    for (const signal of ["load.ev/power", "pt_35h177gqtrb93b3s7n5y6t65rv"])
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
    const r = success([
      "set",
      "kutis",
      "ev",
      "--unset=hysteresis",
      "--unset=delayOn",
    ]);
    expect(r.flags.unset).toEqual(["hysteresis", "delayOn"]);
  });

  it("refuses an --unset that is not a knob", () => {
    // `signalKind` IS a params key, but it is not a threshold knob and clearing it would leave the
    // detector with no signal kind at all.
    expect(failure(["set", "kutis", "ev", "--unset=signalKind"])).toMatch(
      /unset/i,
    );
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
      expect(success(["set", "kutis", "ev", flag]).ok).toBe(true);
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
});

describe("recompute", () => {
  it("requires the derivation — there is no unscoped form", () => {
    // The whole reason this verb posts to `…/derivations/{dx_}/recompute` rather than the cron.
    expect(failure(["recompute", "kutis"])).toMatch(/derivation/i);
  });

  it("defaults to regenerate and refuses an unknown action", () => {
    expect(success(["recompute", "kutis", "ev"]).flags.action).toBe(
      "regenerate",
    );
    expect(failure(["recompute", "kutis", "ev", "--action=rebuild"])).toMatch(
      /action/i,
    );
  });

  it("refuses a malformed date rather than sending it", () => {
    expect(failure(["recompute", "kutis", "ev", "--start=6 July"])).toMatch(
      /start/i,
    );
    expect(failure(["recompute", "kutis", "ev", "--start=2026-13-01"])).toMatch(
      /start/i,
    );
  });

  it("accepts a whole window", () => {
    const r = success([
      "recompute",
      "kutis",
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
  it("takes an area for list, and an area plus a derivation for the rest", () => {
    expect(success(["list", "kutis"]).args).toEqual(["kutis"]);
    expect(failure(["list"])).toMatch(/area/i);
    expect(success(["intervals", "kutis", "ev"]).args).toEqual(["kutis", "ev"]);
    expect(failure(["intervals", "kutis", "ev", "extra"])).toBeTruthy();
  });

  it("suggests the right verb for a near miss", () => {
    // The harness's Levenshtein hint; worth asserting once so a renamed verb keeps it.
    expect(failure(["recompute-all", "kutis"])).toMatch(/recompute/);
  });
});
