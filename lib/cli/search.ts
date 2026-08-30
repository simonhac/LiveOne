/**
 * cli-search.ts — rank the generated tool catalogue against a plain-English query.
 *
 * PORTED from nanti's `src/lib/cli-search.ts`, constants and reasoning intact. The tuning below is
 * the interesting part: every constant deviates from a textbook BM25 for a measured reason, and the
 * comments are the record of why.
 *
 * WHY BM25 AND NOT AN EMBEDDING. It is offline, deterministic, needs no model call and no budget,
 * and the corpus is a couple of hundred short documents of domain vocabulary an agent already
 * knows. A ranking that costs an API call to answer "which command edits a dashboard card" would be
 * consulted less than the grep it replaces.
 *
 * SCORED OVER FIELDS, NOT ONE BLOB. A hit in `when` — the field written to answer exactly this
 * question — should outrank the same word buried in a paragraph about how to read the output, so
 * the fields are weighted rather than concatenated.
 *
 * Everything here is pure: a catalogue and a query in, ranked hits out. No I/O, no clock.
 */

/** One entry of docs/cli-tools.json. */
export interface CatalogueTool {
  name: string;
  summary: string;
  when: string;
  /** The parent's routing text, for a subcommand. Shared across siblings by design. */
  parentWhen?: string;
  description: string;
  signature: string;
  invocation: string;
  file: string;
  input_schema: {
    type: "object";
    properties: Record<string, Record<string, unknown>>;
    required?: string[];
  };
}

export interface Hit {
  name: string;
  summary: string;
  signature: string;
  invocation: string;
  /** True when the command writes — the caller needs to know before it constructs a call. */
  writes: boolean;
  score: number;
}

export interface SearchResult {
  hits: Hit[];
  /**
   * True when lower-ranked candidates were dropped to stay inside the budget. Never
   * silent: a truncated result set that looks complete is the same failure as a query
   * window past the end of the ledger reading as "nothing happened".
   */
  truncated: boolean;
}

/**
 * Field weights. `when` and `name` lead because both are written to be matched — the one
 * deliberately, the other because a command's name is the thing people half-remember.
 */
/**
 * Field weights. `when` and `name` lead because both are written to be matched — the one
 * deliberately, the other because a command's name is the thing people half-remember.
 *
 * `parentWhen` sits BELOW `summary` on purpose. Every sibling under one parent carries the
 * same text, so it cannot discriminate between them: its job is to bring the family into
 * contention on a query aimed at the tool, and then let the child's own summary and name
 * decide the member. Weighted like an own-`when` it would rank four identical-scoring
 * siblings above a better single answer elsewhere.
 */
const WEIGHTS = {
  name: 4,
  when: 5,
  summary: 3,
  params: 1.5,
  description: 1,
} as const;

/**
 * The most a parent's routing text can add to any one subcommand.
 *
 * A parent's `when` is shared by every sibling under it, so as an indexed field it STACKS:
 * `vendors`' text mentions "payee", and all four `vendors__*` entries then scored within
 * 0.13 of each other on "who did I pay" and pushed `bank-txn-search` off the list. Lowering
 * the weight did not fix it — at 2, 1, 0.6 and 0.4 the family still arrived as a block,
 * because the problem is not what the text is worth but that N commands share it.
 *
 * So it is scored separately and capped. It can lift a family into contention on a query
 * aimed at the TOOL, where the competition is weak, and it can never outrank a command that
 * matched on its own fields. Holding it out of the indexed document also keeps it out of
 * the length normalisation, which was inflating short siblings a second time.
 */
const PARENT_BONUS_CAP = 1.0;

const BM25_K1 = 1.2;
/**
 * Length normalisation, deliberately weaker than the textbook 0.75.
 *
 * BM25 penalises long documents because in an ordinary corpus length means the document
 * covers MORE TOPICS, so any one match is diluted. That does not hold here: a long entry
 * is one whose `description` documents more TRAPS — bank-txn-search's is entirely about how
 * to not misread its own output — and it is no less about its subject
 * for it. At 0.75 the most carefully documented tools ranked worst, which is precisely
 * backwards.
 */
const BM25_B = 0.4;

/**
 * Words that carry no signal in a corpus where every document is a command.
 *
 * "who" is deliberately NOT here, unlike in the corpus this was ported from: a command is
 * literally named `whoami` (the prefix rule reaches it from "who"), and "who changed this"
 * is a real operator question that `dashboard history` answers. Dropping it made
 * `liveone find "who am i"` return nothing at all.
 */
const STOP = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "did",
  "do",
  "does",
  "for",
  "from",
  "has",
  "have",
  "how",
  "i",
  "if",
  "in",
  "is",
  "it",
  "its",
  "me",
  "my",
  "of",
  "on",
  "or",
  "that",
  "the",
  "then",
  "there",
  "this",
  "to",
  "was",
  "were",
  "what",
  "when",
  "which",
  "will",
  "with",
  "you",
  "your",
]);

/**
 * Light English stemming — enough that "payments", "paying" and "payment" collide, and no
 * more. A real Porter stemmer would also fold "generic" to "gener" and start matching
 * "generate", which in a corpus this small costs more precision than the recall is worth.
 */
export function stem(word: string): string {
  let w = word;
  for (const [suffix, min] of [
    ["ing", 5],
    ["ies", 4],
    ["ed", 4],
    ["es", 4],
    ["ly", 4],
    ["s", 3],
  ] as const)
    if (w.length >= min && w.endsWith(suffix)) {
      w = w.slice(0, -suffix.length);
      break;
    }
  return w;
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map(stem);
}

/** The parameter half: flag and positional names, plus their help text. */
function paramText(tool: CatalogueTool): string {
  return Object.entries(tool.input_schema.properties ?? {})
    .map(
      ([k, p]) =>
        `${k} ${typeof p.description === "string" ? p.description : ""}`,
    )
    .join(" ");
}

interface Doc {
  tool: CatalogueTool;
  /** term → weighted frequency */
  tf: Map<string, number>;
  length: number;
  /** The parent's routing terms, held apart from the indexed document. */
  parentTf: Map<string, number>;
}

export interface Index {
  docs: Doc[];
  /** term → number of documents containing it */
  df: Map<string, number>;
  avgLength: number;
}

export function buildIndex(tools: CatalogueTool[]): Index {
  const docs: Doc[] = tools.map((tool) => {
    const tf = new Map<string, number>();
    const add = (text: string, weight: number) => {
      for (const t of tokenize(text)) tf.set(t, (tf.get(t) ?? 0) + weight);
    };
    // The name is split on separators by tokenize, so "bank-txn-search" indexes as three
    // terms — which is what makes a query of any one of them reach it.
    add(tool.name, WEIGHTS.name);
    add(tool.when, WEIGHTS.when);
    add(tool.summary, WEIGHTS.summary);
    add(paramText(tool), WEIGHTS.params);
    add(tool.description, WEIGHTS.description);
    let length = 0;
    for (const v of tf.values()) length += v;
    // Scored apart, so it neither stacks across siblings nor distorts the length.
    const parentTf = new Map<string, number>();
    for (const t of tokenize(tool.parentWhen ?? ""))
      parentTf.set(t, (parentTf.get(t) ?? 0) + 1);
    return { tool, tf, length, parentTf };
  });

  const df = new Map<string, number>();
  for (const d of docs)
    for (const t of d.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const avgLength =
    docs.reduce((n, d) => n + d.length, 0) / Math.max(1, docs.length);
  return { docs, df, avgLength };
}

/**
 * Okapi BM25.
 *
 * A query term that appears in a term's PREFIX also counts, at a discount: "pay" has to
 * reach "payee" and "payment", and stemming cannot do that — it truncates suffixes, and
 * "payee" is not "pay" plus one. The discount keeps a prefix hit from outranking an exact
 * one, and the four-character floor keeps "in" from matching half the corpus.
 */
function scoreDoc(index: Index, doc: Doc, terms: string[]): number {
  let score = 0;
  for (const term of terms) {
    let freq = doc.tf.get(term) ?? 0;
    let df = index.df.get(term) ?? 0;
    if (freq === 0 && term.length >= 3) {
      for (const [t, f] of doc.tf)
        if (t.startsWith(term) || term.startsWith(t)) {
          freq = Math.max(freq, f * 0.5);
          df = Math.max(df, index.df.get(t) ?? 0);
        }
    }
    if (freq === 0) continue;
    const idf = Math.log(1 + (index.docs.length - df + 0.5) / (df + 0.5));
    score +=
      idf *
      ((freq * (BM25_K1 + 1)) /
        (freq +
          BM25_K1 * (1 - BM25_B + BM25_B * (doc.length / index.avgLength))));
  }
  return score;
}

/**
 * Names close enough to a mistyped one to be worth offering.
 *
 * SEPARATOR-INSENSITIVE. A caller with a name in mind gets the separator wrong far more
 * often than the letters — `investments statements` or `investments-statements` for
 * `investments__statements` — and plain substring matching recovers none of those, so the
 * error fell back to "run --index", which is the entire catalogue for a one-character
 * mistake. Fold every run of non-alphanumerics to a single space on both sides first.
 */
export function nearestNames(
  query: string,
  names: readonly string[],
  limit = 8,
): string[] {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/gi, " ")
      .trim();
  const q = norm(query);
  if (!q) return [];
  return names
    .filter((n) => {
      const c = norm(n);
      return c.includes(q) || q.includes(c);
    })
    .slice(0, limit);
}

/** The capped contribution of the parent's routing text. See PARENT_BONUS_CAP. */
function parentBonus(index: Index, doc: Doc, terms: string[]): number {
  if (!doc.parentTf.size) return 0;
  let raw = 0;
  for (const term of terms) {
    if (!doc.parentTf.has(term)) continue;
    const df = index.df.get(term) ?? 0;
    raw += Math.log(1 + (index.docs.length - df + 0.5) / (df + 0.5));
  }
  return Math.min(raw, PARENT_BONUS_CAP);
}

/** Does this command write? Read off the schema, since only a mutating command has --apply. */
function writes(tool: CatalogueTool): boolean {
  return "apply" in (tool.input_schema.properties ?? {});
}

/**
 * Rank, then trim to the budget.
 *
 * `limit` bounds how many the caller asked for; `budgetChars` bounds what comes back, and
 * a result trimmed by either sets `truncated`. Both directions matter: a caller that asked
 * for 5 and got 5 still needs to know whether a sixth was in contention.
 */
export function search(
  index: Index,
  query: string,
  opts: { limit?: number; budgetChars?: number; exclude?: string } = {},
): SearchResult {
  const limit = opts.limit ?? 5;
  const budgetChars = opts.budgetChars ?? 4000;
  const terms = tokenize(query);
  if (!terms.length) return { hits: [], truncated: false };

  const scored = index.docs
    // `exclude` is how the searching tool keeps itself out of its own results. cli-find's
    // vocabulary is "find the command for a job" / "in plain English", which matches
    // essentially every query, and it was taking a slot from a real answer nearly every
    // time. An agent already running it does not need to be told it exists.
    .filter((d) => d.tool.name !== opts.exclude)
    .map((doc) => ({
      doc,
      score: scoreDoc(index, doc, terms) + parentBonus(index, doc, terms),
    }))
    .filter((s) => s.score > 0)
    // Ties break on name so the ranking is deterministic — this feeds a committed
    // expectation in the tests and a diff nobody should have to re-read.
    .sort(
      (a, b) =>
        b.score - a.score || a.doc.tool.name.localeCompare(b.doc.tool.name),
    );

  const hits: Hit[] = [];
  let used = 0;
  for (const { doc, score } of scored.slice(0, limit)) {
    const hit: Hit = {
      name: doc.tool.name,
      summary: doc.tool.summary,
      signature: doc.tool.signature,
      invocation: doc.tool.invocation,
      writes: writes(doc.tool),
      score: Math.round(score * 1000) / 1000,
    };
    const cost =
      hit.name.length +
      hit.summary.length +
      hit.signature.length +
      hit.invocation.length;
    if (hits.length && used + cost > budgetChars)
      return { hits, truncated: true };
    used += cost;
    hits.push(hit);
  }
  return { hits, truncated: scored.length > hits.length };
}
