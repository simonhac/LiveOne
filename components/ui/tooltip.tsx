"use client";

/**
 * shadcn Tooltip (Radix), with a beak. Use this instead of a native `title=` — the OS tooltip is
 * unstyled, slow to appear, and clipped to nothing we control. Content portals to <body>, so it
 * escapes a tile's rounded-corner overflow clip.
 */
import * as React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { cn } from "@/lib/utils";

/**
 * Radix tooltips are hover/focus only — on a phone, tapping a trigger does nothing. This context
 * lets `TooltipTrigger` turn a tap into a toggle (see there).
 */
const TapContext = React.createContext<{
  open: boolean;
  setOpen: (open: boolean) => void;
  /** Swallow Radix's close-on-click for the tap that just opened us. */
  ignoreCloseRef: React.RefObject<boolean>;
} | null>(null);

/** Each tooltip carries its own provider, so no app-root wiring is needed. */
function Tooltip({
  delayDuration = 200,
  open: openProp,
  onOpenChange,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root> & {
  delayDuration?: number;
}) {
  const [openState, setOpenState] = React.useState(false);
  const open = openProp ?? openState;
  const ignoreCloseRef = React.useRef(false);
  const setOpen = React.useCallback(
    (next: boolean) => {
      if (!next && ignoreCloseRef.current) return;
      setOpenState(next);
      onOpenChange?.(next);
    },
    [onOpenChange],
  );
  return (
    <TapContext.Provider value={{ open, setOpen, ignoreCloseRef }}>
      <TooltipPrimitive.Provider delayDuration={delayDuration}>
        <TooltipPrimitive.Root open={open} onOpenChange={setOpen} {...props} />
      </TooltipPrimitive.Provider>
    </TapContext.Provider>
  );
}

/** A trigger that is itself a control (a button, a link, a menu item) acts on tap, not explains. */
const INTERACTIVE = "button, a, input, select, textarea, [role^='menuitem']";

/**
 * On a touch tap, a NON-interactive trigger (an icon, a label, a table cell) toggles its tooltip; a
 * tap elsewhere closes it (Radix's outside-pointerdown dismiss). Whether it was open is read at
 * pointerdown, because that same pointerdown counts as "outside" the content and closes it before
 * the click arrives — reading it at click time would re-open what the user just tapped shut.
 */
function TooltipTrigger({
  onPointerDown,
  onClick,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  const tap = React.useContext(TapContext);
  const touch = React.useRef<{ wasOpen: boolean } | null>(null);
  return (
    <TooltipPrimitive.Trigger
      {...props}
      onPointerDown={(e) => {
        touch.current =
          e.pointerType === "touch" ? { wasOpen: tap?.open ?? false } : null;
        onPointerDown?.(e);
      }}
      onClick={(e) => {
        onClick?.(e);
        const t = touch.current;
        touch.current = null;
        if (!tap || !t || e.currentTarget.matches(INTERACTIVE)) return;
        if (t.wasOpen) return tap.setOpen(false);
        tap.ignoreCloseRef.current = true;
        tap.setOpen(true);
        // Radix's own click handler (composed after this one) closes; swallow that one call.
        queueMicrotask(() => (tap.ignoreCloseRef.current = false));
      }}
    />
  );
}

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
          "z-[9999] max-w-xs rounded-lg px-3 py-2 text-xs leading-snug text-ink bg-surface-glass shadow-xl ring-1 ring-wash ring-inset backdrop-blur-lg backdrop-saturate-150",
          className,
        )}
        {...props}
      >
        {children}
        <TooltipPrimitive.Arrow
          className="fill-surface-glass"
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
