"use client";

import { useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  commandLogPagesQuery,
  commandLogQuery,
  INLINE_LOG_LIMIT,
} from "@/lib/queries/commands";
import { formatCommandEntry } from "@/lib/control/command-log";
import { renderMessageLike } from "@/lib/control/message-format";
import { formatTime12h } from "@/lib/fe-date-format";
import type { CommandLogEntryJson } from "@/lib/control/command-log";

/**
 * "Last activity" — the command audit trail (`point_commands`) as sentences, inside a control
 * dialog. "Why did my car stop charging at 2am", or "who started the generator", gets answered here
 * rather than in SQL.
 *
 * VENDOR-NEUTRAL. It was `TeslaActivityLog`, but nothing in it was ever about a car: the route is
 * addressed by a `pt_`, and every word comes from `formatCommandEntry`, whose voice is keyed off the
 * point's ADDRESS. So the generator dialog reuses it as-is rather than growing a second copy that
 * would drift.
 *
 * ## One, then a door
 *
 * Always visible, showing the newest ONE. It used to be collapsed behind a disclosure, which saved
 * a fetch but hid the answer to "did that command actually land" behind a click, immediately after
 * the press that raised the question. One row answers exactly that and nothing else, which is what
 * lets the whole dialog fit a phone; the history that answers "what happened last night" stays
 * reachable through "Show more", which opens the full trail in its own modal — layered OVER this
 * dialog at the same width, so nothing resizes — 50 rows at a time. The route reports whether a
 * further row exists (`hasMore`), so the door only appears when there is something behind it.
 *
 * The dialog invalidates `queryKeys.commands(pt)` after each of its own commands, so a press shows
 * up here immediately.
 */
export default function CommandActivityLog({
  pt,
  modalWidthClass,
}: {
  /** The point the log route is addressed by (`ev.charge/active`, the generator run request, …).
   *  Null ⇒ nothing to show. */
  pt: string | null;
  /**
   * The Tailwind max-width of the dialog this log sits IN, so the "Show more" modal opens at the
   * same size rather than resizing the stack.
   *
   * Passed down rather than fixed here because the two consumers are different widths (the charge
   * dialog is `sm:max-w-sm`, the generator's `sm:max-w-md`), so there is no one right answer — and
   * each parent declares it once and hands the same constant to both its own DialogContent and to
   * this, which is what stops the two from drifting apart.
   */
  modalWidthClass: string;
}) {
  const [allOpen, setAllOpen] = useState(false);
  const log = useQuery({
    ...commandLogQuery(pt, INLINE_LOG_LIMIT),
    enabled: !!pt,
  });

  if (!pt) return null;

  const entries = log.data?.commands ?? [];

  return (
    <div className="pt-1">
      {/* Heading and "Show more" share one line, and the list below it is a single row. Three lines
          of history was what tipped this dialog past a phone screen, and the trail itself is one
          tap away — the peek only has to answer "did my last press land?". */}
      <div className="mb-1 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1 text-sm text-gray-400">
          Last activity
          {log.isLoading && (
            <Loader2 className="h-3 w-3 animate-spin text-gray-500" />
          )}
        </div>
        {!log.isLoading && log.data?.hasMore && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => setAllOpen(true)}
          >
            Show more
          </Button>
        )}
      </div>

      {!log.isLoading && <EntryList entries={entries} />}

      <AllActivityDialog
        pt={pt}
        open={allOpen}
        onOpenChange={setAllOpen}
        widthClass={modalWidthClass}
      />
    </div>
  );
}

/** The whole trail, paged. Mounted only once opened, so it costs nothing until asked for. */
function AllActivityDialog({
  pt,
  open,
  onOpenChange,
  widthClass,
}: {
  pt: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  widthClass: string;
}) {
  const pages = useInfiniteQuery({
    ...commandLogPagesQuery(pt),
    enabled: open,
  });

  const entries = pages.data?.pages.flatMap((p) => p.commands) ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* `nested`: this opens OVER the control dialog that spawned it, and must read that way —
          without it the second backdrop blanks the parent and the trail looks like a replacement
          rather than a layer. `widthClass` is the parent's own, so the stack does not resize. */}
      <DialogContent className={widthClass} nested>
        <DialogHeader>
          <DialogTitle>Activity</DialogTitle>
        </DialogHeader>
        {/* The SCROLLER is here and not on the page: the header stays put and the "Load more"
            below stays at the end of the list, where a reader who has scrolled to the bottom is
            already looking. */}
        <div className="max-h-[60vh] overflow-y-auto pr-1">
          {pages.isLoading ? (
            <p className="py-6 text-center text-xs text-gray-500">
              <Loader2 className="mx-auto h-4 w-4 animate-spin" />
            </p>
          ) : (
            <EntryList entries={entries} />
          )}
          {pages.hasNextPage && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-3 w-full text-xs"
              disabled={pages.isFetchingNextPage}
              onClick={() => void pages.fetchNextPage()}
            >
              {pages.isFetchingNextPage ? (
                <Loader2 className="mr-2 h-3 w-3 animate-spin" />
              ) : null}
              Show more
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** The rows themselves — one rendering, shared by the inline peek and the modal. */
function EntryList({ entries }: { entries: CommandLogEntryJson[] }) {
  const lines = entries.map((entry) => formatCommandEntry(entry, Date.now()));
  if (lines.length === 0) {
    return <p className="mt-2 text-xs text-gray-500">Nothing yet.</p>;
  }
  return (
    <ul className="mt-2 space-y-1.5 text-xs">
      {lines.map((line, i) => (
        <li key={`${line.timeMs}-${i}`} className="flex gap-2">
          <span className="shrink-0 tabular-nums text-gray-500">
            {timeWords(line.timeMs)}
          </span>
          <span
            className={
              line.tone === "error"
                ? "text-red-400/90"
                : line.tone === "pending"
                  ? "text-gray-400 italic"
                  : "text-gray-300"
            }
          >
            {/* A vendor sentence can carry an instant the hub had no clock to spell. */}
            {renderMessageLike(line.sentence) ?? line.sentence}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * "9:08pm", with a "yesterday"/short-date prefix once the local day differs.
 *
 * The house 12-hour spelling (`formatTime12h`), not `toLocaleTimeString` — which followed the
 * browser's locale into 24-hour time on an en-AU/en-GB profile and printed "23:58" in a dialog
 * where every other time reads "12:03am".
 */
function timeWords(ms: number): string {
  const then = new Date(ms);
  const now = new Date();
  const time = formatTime12h({
    hour: then.getHours(),
    minute: then.getMinutes(),
  });
  const dayDiff =
    (new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() -
      new Date(then.getFullYear(), then.getMonth(), then.getDate()).getTime()) /
    86_400_000;
  if (dayDiff === 0) return time;
  if (dayDiff === 1) return `yesterday ${time}`;
  return `${then.toLocaleDateString([], { day: "numeric", month: "short" })} ${time}`;
}
