import { CalendarDate } from "@internationalized/date";

/**
 * Plan ONE bounded batch of a backward flow-matrix recompute. Given the full `[start, end]` range, the
 * `cursor` (the most-recent day still to do — clamped to `end`), and a per-batch `limit`, return the
 * days to recompute THIS call (newest → oldest), the `nextCursor` to resume from (null once the range is
 * exhausted), and `done`. The caller loops: run the batch, then re-run with `nextCursor` until `done`.
 * Bounding each call is what keeps a long range from blowing the function timeout.
 */
export function planFlowRecomputeBatch(opts: {
  start: CalendarDate;
  end: CalendarDate;
  cursor: CalendarDate;
  limit: number;
}): { days: CalendarDate[]; nextCursor: CalendarDate | null; done: boolean } {
  const { start, end, limit } = opts;
  let cursor = opts.cursor;
  if (cursor.compare(end) > 0) cursor = end;

  const days: CalendarDate[] = [];
  let day = cursor;
  for (let i = 0; i < limit && day.compare(start) >= 0; i++) {
    days.push(day);
    day = day.subtract({ days: 1 });
  }
  const done = day.compare(start) < 0; // the next day would fall before start
  return { days, nextCursor: done ? null : day, done };
}
