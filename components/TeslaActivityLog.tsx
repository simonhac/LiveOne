"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { commandLogQuery } from "@/lib/queries/commands";
import { formatCommandEntry } from "@/lib/control/command-log";

/**
 * "Recent activity" — the command audit trail (`point_commands`) as sentences, inside the
 * charge-control dialog. "Why did my car stop charging at 2am" gets answered here rather
 * than in SQL.
 *
 * Collapsed by default and the query is enabled only while expanded: the list is one fetch of
 * 20 rows, but there's no reason to spend it (or its 30 s refetch) on every dialog open. The
 * dialog invalidates `queryKeys.commands(activePt)` after each of its own commands, so a press
 * shows up here immediately once expanded.
 */
export default function TeslaActivityLog({
  activePt,
}: {
  /** `ev.charge/active` — the point the log route is addressed by. Null ⇒ nothing to show. */
  activePt: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const log = useQuery({
    ...commandLogQuery(activePt),
    enabled: !!activePt && expanded,
  });

  if (!activePt) return null;

  const lines = (log.data?.commands ?? []).map((entry) =>
    formatCommandEntry(entry, Date.now()),
  );

  return (
    <div className="border-t border-gray-700 pt-3">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-1 text-sm text-gray-400 transition-colors hover:text-gray-200"
      >
        {expanded ? (
          <ChevronDown className="h-4 w-4" />
        ) : (
          <ChevronRight className="h-4 w-4" />
        )}
        Recent activity
        {expanded && log.isLoading && (
          <Loader2 className="ml-1 h-3 w-3 animate-spin text-gray-500" />
        )}
      </button>

      {expanded && !log.isLoading && (
        <ul className="mt-2 max-h-56 space-y-1.5 overflow-y-auto text-xs">
          {lines.length === 0 && (
            <li className="text-gray-500">Nothing yet.</li>
          )}
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
                {line.sentence}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** "9:08 pm", with a "yesterday"/short-date prefix once the local day differs. */
function timeWords(ms: number): string {
  const then = new Date(ms);
  const now = new Date();
  const time = then.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  const dayDiff =
    (new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() -
      new Date(then.getFullYear(), then.getMonth(), then.getDate()).getTime()) /
    86_400_000;
  if (dayDiff === 0) return time;
  if (dayDiff === 1) return `yesterday ${time}`;
  return `${then.toLocaleDateString([], { day: "numeric", month: "short" })} ${time}`;
}
