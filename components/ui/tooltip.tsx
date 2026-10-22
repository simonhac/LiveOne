"use client";

/**
 * shadcn Tooltip (Radix), with a beak. Use this instead of a native `title=` — the OS tooltip is
 * unstyled, slow to appear, and clipped to nothing we control. Content portals to <body>, so it
 * escapes a tile's rounded-corner overflow clip.
 */
import * as React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { cn } from "@/lib/utils";

/** Each tooltip carries its own provider, so no app-root wiring is needed. */
function Tooltip({
  delayDuration = 200,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root> & {
  delayDuration?: number;
}) {
  return (
    <TooltipPrimitive.Provider delayDuration={delayDuration}>
      <TooltipPrimitive.Root {...props} />
    </TooltipPrimitive.Provider>
  );
}

const TooltipTrigger = TooltipPrimitive.Trigger;

function TooltipContent({
  className,
  sideOffset = 6,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        sideOffset={sideOffset}
        collisionPadding={8}
        className={cn(
          "z-[9999] max-w-xs rounded-lg bg-surface-raised px-3 py-2 text-xs leading-snug text-ink shadow-xl",
          className,
        )}
        {...props}
      >
        {children}
        <TooltipPrimitive.Arrow
          className="fill-surface-raised"
          width={12}
          height={6}
        />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}

/**
 * The common case: hang a hint on one element. Renders the child untouched when there is nothing to
 * say, so a conditional `title={cond ? "…" : undefined}` ports over as-is. The child must accept a
 * ref and spread props (a DOM element, or a Radix part such as `DropdownMenu.Trigger asChild`) —
 * put `Hint` OUTSIDE other `asChild` wrappers, never inside them. It replaces a native `title=`, so
 * an icon-only control should carry its own `aria-label`.
 */
function Hint({
  content,
  side,
  children,
}: {
  content: React.ReactNode;
  side?: React.ComponentProps<typeof TooltipPrimitive.Content>["side"];
  children: React.ReactElement;
}) {
  if (content == null || content === false || content === "") return children;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side}>{content}</TooltipContent>
    </Tooltip>
  );
}

export { Tooltip, TooltipTrigger, TooltipContent, Hint };
