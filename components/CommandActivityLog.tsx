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
 * "Recent activity" — the command audit trail (`point_commands`) as sentences, inside a control
 * dialog. "Why did my car stop charging at 2am", or "who started the generator", gets answered here
 * rather than in SQL.
 *
 * VENDOR-NEUTRAL. It was `TeslaActivityLog`, but nothing in it was ever about a car: the route is
 * addressed by a `pt_`, and every word comes from `formatCommandEntry`, whose voice is keyed off the
 * point's ADDRESS. So the generator dialog reuses it as-is rather than growing a second copy that
 * would drift.
 *
 * ## Two, then a door
 *
 * Always visible, showing the newest TWO. It used to be collapsed behind a disclosure, which saved
 * a fetch but hid the answer to "did that command actually land" behind a click, immediately after
 * the press that raised the question. Two rows is small enough to sit under the buttons without
 * pushing them off the dialog, and the history that answers "what happened last night" stays
 * reachable through "Show more", which opens the full trail in its own modal 50 rows at a time. The
 * route reports whether a third row exists (`hasMore`), so the door only appears when there is
 * something behind it.
 *
 * The dialog invalidates `queryKeys.commands(pt)` after each of its own commands, so a press shows
 * up here immediately.
 */
export default function CommandActivityLog({
  pt,
}: {
  /** The point the log route is addressed by (`ev.charge/active`, the generator run request, …).
   *  Null ⇒ nothing to show. */
  pt: string | null;
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
      <div className="mb-1 flex items-center gap-1 text-sm text-gray-400">
        Recent activity
        {log.isLoading && (
          <Loader2 className="h-3 w-3 animate-spin text-gray-500" />
        )}
      </div>

      {!log.isLoading && (
        <>
          <EntryList entries={entries} />
          {log.data?.hasMore && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="mt-1 h-7 px-1 text-xs text-gray-400 hover:text-gray-200"
              onClick={() => setAllOpen(true)}
            >
              Show more
            </Button>
          )}
        </>
      )}

      <AllActivityDialog pt={pt} open={allOpen} onOpenChange={setAllOpen} />
    </div>
  );
}

/** The whole trail, paged. Mounted only once opened, so it costs nothing until asked for. */
function AllActivityDialog({
  pt,
  open,
  onOpenChange,
}: {
  pt: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const pages = useInfiniteQuery({
    ...commandLogPagesQuery(pt),
    enabled: open,
  });

  const entries = pages.data?.pages.flatMap((p) => p.commands) ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
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
