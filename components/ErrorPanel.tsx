import type { ReactNode } from "react";
import { AlertTriangle } from "lucide-react";

/**
 * The app's "this couldn't be loaded" notice: amber, inline, and always saying WHAT is missing
 * rather than shimmering forever or collapsing to nothing.
 *
 * One component so the vocabulary stays one vocabulary — an unresolvable area, a removed device and
 * a render-time crash should all read as the same kind of event, because to the person looking at
 * them they are. Deliberately not a full-page treatment: it is sized by its container, so it works
 * both as a card-sized notice inside a dashboard section and as the body of the root error boundary.
 *
 * No "use client" directive: it holds no state, so it composes into server and client trees alike.
 */
export function ErrorPanel({
  title,
  children,
  className,
}: {
  title: string;
  /** The explanation under the title — what happened, and what the reader can do about it. */
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`flex items-start gap-2.5 rounded-lg border border-amber-800/40 bg-amber-950/20 px-4 py-3 text-sm${className ? ` ${className}` : ""}`}
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-400" />
      {/* `min-w-0` so a long unbroken value in the message (a pasted URL, an id) wraps instead of
          forcing the panel wider than its container. */}
      <div className="min-w-0">
        <p className="font-medium text-amber-200">{title}</p>
        <p className="mt-0.5 text-amber-200/70">{children}</p>
      </div>
    </div>
  );
}
