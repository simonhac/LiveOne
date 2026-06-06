import { randomInt } from "crypto";
import { and, desc, eq, isNull, gt, or } from "drizzle-orm";
import { db } from "@/lib/db/turso";
import { shareTokens } from "@/lib/db/turso/schema";
import { CONFIG_WRITES_TO_PG } from "@/lib/db/routing";
import { shadowReadConfig, SHADOW_SKIP } from "@/lib/db/config-shadow";
import { planetscaleDb } from "@/lib/db/planetscale";
import { shareTokens as pgShareTokens } from "@/lib/db/planetscale/schema";

// Three-word tokens use the form: <adjective>-<adjective>-<noun>
// Wordlists are intentionally short (single-syllable preferred, no homophones,
// no profanity surrogates). Total entropy ~= log2(128 * 128 * 256) ≈ 22 bits.
// Tokens are revocable + expirable so this is acceptable; brute-force at
// rate-limited request rates is uneconomic vs revoking on misuse.

export const ADJECTIVES_1: readonly string[] = [
  "amber",
  "azure",
  "brave",
  "brisk",
  "bright",
  "busy",
  "calm",
  "clever",
  "cosy",
  "crisp",
  "curly",
  "daring",
  "dapper",
  "dewy",
  "drowsy",
  "dusky",
  "eager",
  "early",
  "earthy",
  "easy",
  "fancy",
  "feisty",
  "fluffy",
  "fond",
  "frosty",
  "fuzzy",
  "gentle",
  "giddy",
  "glad",
  "glassy",
  "glossy",
  "golden",
  "grand",
  "handy",
  "happy",
  "hardy",
  "hasty",
  "hazy",
  "honest",
  "humble",
  "icy",
  "jaunty",
  "jazzy",
  "jolly",
  "jovial",
  "keen",
  "kind",
  "leaping",
  "lively",
  "lonely",
  "lucky",
  "lush",
  "matte",
  "mellow",
  "merry",
  "mighty",
  "minty",
  "misty",
  "modest",
  "moody",
  "mossy",
  "nimble",
  "noble",
  "nutty",
  "oaken",
  "peppy",
  "perky",
  "plucky",
  "plump",
  "polite",
  "proud",
  "quiet",
  "quirky",
  "rapid",
  "ready",
  "regal",
  "ripe",
  "rosy",
  "royal",
  "rusty",
  "sandy",
  "sassy",
  "silky",
  "silly",
  "silver",
  "sleepy",
  "slim",
  "smug",
  "snappy",
  "snug",
  "sober",
  "soft",
  "solid",
  "sour",
  "spare",
  "spry",
  "stark",
  "steady",
  "sunny",
  "sure",
  "swift",
  "tame",
  "tangy",
  "tender",
  "tidy",
  "timid",
  "tipsy",
  "trim",
  "tropic",
  "trusty",
  "ultra",
  "vivid",
  "wacky",
  "warm",
  "wavy",
  "weary",
  "wee",
  "wide",
  "wild",
  "windy",
  "wise",
  "witty",
  "wobbly",
  "woody",
  "yummy",
  "zany",
  "zesty",
  "zippy",
  "blue",
  "calm",
];

export const ADJECTIVES_2: readonly string[] = [
  "amber",
  "baked",
  "baggy",
  "bare",
  "beady",
  "bendy",
  "bitter",
  "blank",
  "bouncy",
  "brazen",
  "breezy",
  "bubbly",
  "buttery",
  "caged",
  "candid",
  "careful",
  "caring",
  "chalky",
  "chatty",
  "cheery",
  "chilly",
  "chunky",
  "civic",
  "clean",
  "cloudy",
  "clunky",
  "coastal",
  "comic",
  "crafty",
  "cranky",
  "crispy",
  "cuddly",
  "curt",
  "dainty",
  "damp",
  "dapper",
  "dashing",
  "decent",
  "deep",
  "dense",
  "devout",
  "dim",
  "dingy",
  "dizzy",
  "domed",
  "dotted",
  "drab",
  "dreamy",
  "dusty",
  "empty",
  "even",
  "exotic",
  "faded",
  "faint",
  "faithful",
  "famous",
  "feathery",
  "ferny",
  "fierce",
  "fishy",
  "fizzy",
  "flaky",
  "flat",
  "fleet",
  "flighty",
  "floral",
  "floury",
  "fluffy",
  "fluid",
  "foggy",
  "fond",
  "formal",
  "fragile",
  "frank",
  "fresh",
  "fried",
  "frilly",
  "frosty",
  "fruity",
  "funky",
  "furry",
  "fussy",
  "gaudy",
  "gauzy",
  "gawky",
  "gentle",
  "ghostly",
  "giddy",
  "glassy",
  "gleaming",
  "gloomy",
  "glossy",
  "gluey",
  "godly",
  "gooey",
  "gracile",
  "grainy",
  "greasy",
  "greedy",
  "grim",
  "grimy",
  "gritty",
  "gummy",
  "gushy",
  "gusty",
  "hairy",
  "handy",
  "hasty",
  "heady",
  "heavy",
  "herbal",
  "hidden",
  "high",
  "hilly",
  "hoarse",
  "hollow",
  "homely",
  "honest",
  "hopeful",
  "hushed",
  "husky",
  "icy",
  "idle",
  "jazzy",
  "jolly",
  "juicy",
  "jumpy",
  "keen",
  "kindly",
  "kooky",
];

export const NOUNS: readonly string[] = [
  "ant",
  "ape",
  "badger",
  "bat",
  "bear",
  "beaver",
  "bee",
  "beetle",
  "bird",
  "bison",
  "boar",
  "cat",
  "caterpillar",
  "catfish",
  "cheetah",
  "chick",
  "chimp",
  "chipmunk",
  "clam",
  "cobra",
  "cod",
  "cougar",
  "cow",
  "coyote",
  "crab",
  "crane",
  "cricket",
  "crow",
  "cub",
  "deer",
  "dingo",
  "dog",
  "dolphin",
  "donkey",
  "dove",
  "dragon",
  "duck",
  "eagle",
  "eel",
  "elk",
  "emu",
  "falcon",
  "fawn",
  "ferret",
  "finch",
  "fish",
  "flamingo",
  "fox",
  "frog",
  "gazelle",
  "gecko",
  "gerbil",
  "giraffe",
  "gnat",
  "gnu",
  "goat",
  "goldfish",
  "goose",
  "gopher",
  "gorilla",
  "grouse",
  "hare",
  "hawk",
  "hedgehog",
  "hen",
  "heron",
  "hippo",
  "hornet",
  "horse",
  "hound",
  "hummingbird",
  "husky",
  "ibex",
  "ibis",
  "iguana",
  "impala",
  "jackal",
  "jaguar",
  "jay",
  "kangaroo",
  "kingfisher",
  "kiwi",
  "koala",
  "krill",
  "lamb",
  "lark",
  "lemming",
  "lemur",
  "leopard",
  "lion",
  "lizard",
  "llama",
  "lobster",
  "lynx",
  "macaw",
  "magpie",
  "manatee",
  "mantis",
  "marmot",
  "marten",
  "meerkat",
  "minnow",
  "mole",
  "mongoose",
  "monkey",
  "moose",
  "moth",
  "mouse",
  "mule",
  "narwhal",
  "newt",
  "ocelot",
  "octopus",
  "okapi",
  "orca",
  "oriole",
  "osprey",
  "otter",
  "owl",
  "ox",
  "panda",
  "panther",
  "parrot",
  "peacock",
  "pelican",
  "penguin",
  "perch",
  "pheasant",
  "pig",
  "pigeon",
  "pony",
  "porpoise",
  "puffin",
  "pug",
  "puma",
  "quail",
  "quokka",
  "rabbit",
  "raccoon",
  "ram",
  "rat",
  "raven",
  "reindeer",
  "rhino",
  "robin",
  "rooster",
  "salmon",
  "seal",
  "shark",
  "sheep",
  "shrew",
  "shrimp",
  "skunk",
  "sloth",
  "snail",
  "snake",
  "sparrow",
  "spider",
  "squid",
  "squirrel",
  "starling",
  "stork",
  "swan",
  "tapir",
  "tern",
  "thrush",
  "tiger",
  "toad",
  "trout",
  "tuna",
  "turkey",
  "turtle",
  "viper",
  "vole",
  "vulture",
  "wallaby",
  "walrus",
  "warbler",
  "wasp",
  "weasel",
  "whale",
  "wolf",
  "wombat",
  "worm",
  "wren",
  "yak",
  "zebra",
  "alpaca",
  "angora",
  "bison",
  "boa",
  "bream",
  "camel",
  "capon",
  "carp",
  "civet",
  "drake",
  "ewe",
  "gander",
  "heifer",
  "hyena",
  "ipswich",
  "jackrabbit",
  "jenny",
  "kit",
  "ladybug",
  "loris",
  "macaque",
  "mare",
  "midge",
  "moray",
  "muskrat",
  "nag",
  "oryx",
  "ostrich",
  "piranha",
  "platypus",
  "puffer",
  "ray",
  "sable",
  "salamander",
  "sandfly",
  "silkworm",
  "skink",
  "stallion",
  "stoat",
  "sturgeon",
  "swift",
  "tadpole",
  "tarsier",
  "tortoise",
  "tuatara",
  "unicorn",
  "vicuna",
  "whippet",
  "wolverine",
  "woodchuck",
  "yorkie",
  "zebu",
  "zander",
];

function pickRandom<T>(list: readonly T[]): T {
  return list[randomInt(list.length)];
}

export function generateTokenString(): string {
  return [
    pickRandom(ADJECTIVES_1),
    pickRandom(ADJECTIVES_2),
    pickRandom(NOUNS),
  ].join("-");
}

const TOKEN_RE = /^[a-z]+-[a-z]+-[a-z]+$/;

export function isWellFormedToken(token: string): boolean {
  return TOKEN_RE.test(token) && token.length <= 60;
}

export interface CreateShareTokenOptions {
  ownerClerkUserId: string;
  expiresInDays?: number | null; // null/undefined => never expires
  label?: string | null;
}

export async function createShareToken(opts: CreateShareTokenOptions) {
  // Retry on the slim chance of a token collision (PRIMARY KEY violation).
  for (let attempt = 0; attempt < 5; attempt++) {
    const token = generateTokenString();
    const expiresAtMs =
      opts.expiresInDays && opts.expiresInDays > 0
        ? Date.now() + opts.expiresInDays * 24 * 60 * 60 * 1000
        : null;
    try {
      // WRITE ROUTING (1B): when CONFIG_WRITES_TO_PG is on, write the new token
      // to Postgres ONLY (no dual-write to Turso). The Turso `created_at_ms`
      // default doesn't exist in PG, so set it explicitly. Otherwise, today's
      // unchanged Turso insert.
      if (CONFIG_WRITES_TO_PG) {
        if (!planetscaleDb) {
          throw new Error(
            "CONFIG_WRITES_TO_PG is on but PlanetScale is not configured",
          );
        }
        await planetscaleDb.insert(pgShareTokens).values({
          token,
          ownerClerkUserId: opts.ownerClerkUserId,
          label: opts.label ?? null,
          createdAtMs: Date.now(),
          expiresAtMs,
        });
      } else {
        await db.insert(shareTokens).values({
          token,
          ownerClerkUserId: opts.ownerClerkUserId,
          label: opts.label ?? null,
          expiresAtMs,
        });
      }
      return { token, expiresAtMs };
    } catch (err: any) {
      // Token PK collision: Turso surfaces SQLITE_CONSTRAINT / "UNIQUE";
      // Postgres surfaces SQLSTATE 23505 (unique_violation).
      if (
        err?.message?.includes("UNIQUE") ||
        err?.code === "SQLITE_CONSTRAINT" ||
        err?.code === "23505"
      ) {
        continue;
      }
      throw err;
    }
  }
  throw new Error("failed to allocate unique share token");
}

export interface ValidatedToken {
  token: string;
  ownerClerkUserId: string;
}

/**
 * Project a share_tokens row to the fields compared in shadow-diff. share_tokens stores
 * all timestamps as bigint epoch-ms on BOTH sides (Turso integer, PG bigint mode:"number"),
 * so the *Ms columns are plain numbers needing no second/µs translation.
 */
function normalizeShareTokenForShadow(row: unknown): unknown {
  if (!row) return null;
  const s = row as Record<string, any>;
  return {
    token: s.token,
    ownerClerkUserId: s.ownerClerkUserId,
    label: s.label ?? null,
    createdAtMs: s.createdAtMs ?? null,
    expiresAtMs: s.expiresAtMs ?? null,
    revokedAtMs: s.revokedAtMs ?? null,
    lastUsedAtMs: s.lastUsedAtMs ?? null,
  };
}

export async function validateShareToken(
  token: string,
): Promise<ValidatedToken | null> {
  if (!isWellFormedToken(token)) return null;
  // Capture nowMs ONCE and reuse for both Turso and PG reads so the
  // `gt(expiresAtMs, nowMs)` predicate can't false-diff on clock skew.
  const nowMs = Date.now();
  const row = await shadowReadConfig(
    "validateShareToken",
    async () => {
      const rows = await db
        .select()
        .from(shareTokens)
        .where(
          and(
            eq(shareTokens.token, token),
            isNull(shareTokens.revokedAtMs),
            or(
              isNull(shareTokens.expiresAtMs),
              gt(shareTokens.expiresAtMs, nowMs),
            ),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    },
    {
      diffKey: token,
      pgRead: async () => {
        if (!planetscaleDb) return SHADOW_SKIP;
        const rows = await planetscaleDb
          .select()
          .from(pgShareTokens)
          .where(
            and(
              eq(pgShareTokens.token, token),
              isNull(pgShareTokens.revokedAtMs),
              or(
                isNull(pgShareTokens.expiresAtMs),
                gt(pgShareTokens.expiresAtMs, nowMs),
              ),
            ),
          )
          .limit(1);
        return rows[0] ?? null;
      },
      normalize: normalizeShareTokenForShadow,
    },
  );
  if (!row) return null;

  // Best-effort touch of last_used_at_ms (don't await; ignore failure).
  void db
    .update(shareTokens)
    .set({ lastUsedAtMs: nowMs })
    .where(eq(shareTokens.token, token))
    .catch(() => {});

  return { token: row.token, ownerClerkUserId: row.ownerClerkUserId };
}

export async function listShareTokens(ownerClerkUserId: string) {
  return shadowReadConfig(
    "listShareTokens",
    async () =>
      db
        .select()
        .from(shareTokens)
        .where(eq(shareTokens.ownerClerkUserId, ownerClerkUserId))
        .orderBy(desc(shareTokens.createdAtMs)),
    {
      diffKey: ownerClerkUserId,
      pgRead: async () => {
        if (!planetscaleDb) return SHADOW_SKIP;
        return planetscaleDb
          .select()
          .from(pgShareTokens)
          .where(eq(pgShareTokens.ownerClerkUserId, ownerClerkUserId))
          .orderBy(desc(pgShareTokens.createdAtMs));
      },
      normalize: (v: unknown) =>
        Array.isArray(v) ? v.map(normalizeShareTokenForShadow) : v,
    },
  );
}

export async function revokeShareToken(
  token: string,
  ownerClerkUserId: string,
) {
  const revokedAtMs = Date.now();
  // WRITE ROUTING (1B): Postgres-only when CONFIG_WRITES_TO_PG is on; otherwise
  // today's unchanged Turso update. Both back-ends use `.returning()` so the
  // revoked-a-matching-row check is identical.
  if (CONFIG_WRITES_TO_PG) {
    if (!planetscaleDb) {
      throw new Error(
        "CONFIG_WRITES_TO_PG is on but PlanetScale is not configured",
      );
    }
    const result = await planetscaleDb
      .update(pgShareTokens)
      .set({ revokedAtMs })
      .where(
        and(
          eq(pgShareTokens.token, token),
          eq(pgShareTokens.ownerClerkUserId, ownerClerkUserId),
          isNull(pgShareTokens.revokedAtMs),
        ),
      )
      .returning();
    return result.length > 0;
  }

  const result = await db
    .update(shareTokens)
    .set({ revokedAtMs })
    .where(
      and(
        eq(shareTokens.token, token),
        eq(shareTokens.ownerClerkUserId, ownerClerkUserId),
        isNull(shareTokens.revokedAtMs),
      ),
    )
    .returning();
  return result.length > 0;
}
