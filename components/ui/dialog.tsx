"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogPortal = DialogPrimitive.Portal;
const DialogClose = DialogPrimitive.Close;

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "fixed inset-0 z-50 bg-black/50 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className,
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

interface DialogContentProps
  extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
  /**
   * This dialog opens ON TOP of another one (the activity trail over a control dialog).
   *
   * Two portals with the same z-index paint in DOM order, so a nested dialog's BACKDROP lands above
   * the parent's content — and at the default `bg-black/50 backdrop-blur-sm` that blanks the parent
   * entirely, which reads as "the dialog I was in disappeared" rather than "something opened over
   * it". This lifts the nested content above the parent and softens its backdrop to a plain dim, so
   * the parent stays legible underneath and the stack is visibly a stack.
   */
  nested?: boolean;
}

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  DialogContentProps
>(({ className, children, nested = false, style, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay
      className={cn(nested && "z-[55] bg-black/40 backdrop-blur-none")}
    />
    <DialogPrimitive.Content
      onPointerDownOutside={(e) => e.preventDefault()}
      onInteractOutside={(e) => e.preventDefault()}
      ref={ref}
      /**
       * The nested offset, nudged off-centre so the parent's edge stays visible behind it. Same
       * WIDTH as the parent (the caller passes it down), so nothing resizes — but exactly on top at
       * exactly the same size reads as "this panel's contents changed" rather than as a second
       * panel, and the sliver of the parent down one side is what makes it a stack.
       *
       * INLINE, not a class, and that is not laziness: the base class list already carries
       * `translate-x-[-50%]` and `p-6`, and `cn`'s tailwind-merge collapses any offset utility into
       * the same conflict group and drops it — verified in the browser, where both a
       * `translate-x-[calc(…)]` and an `ml-3`/`mt-3` attempt vanished from the rendered class list
       * while a `z-[60]` in the very same string survived. A style property has no group to lose.
       */
      style={nested ? { marginLeft: 12, marginTop: 12, ...style } : style}
      className={cn(
        "fixed left-[50%] top-[50%] z-50 grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 border border-gray-700 bg-gray-800 p-6 shadow-lg duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%] sm:rounded-lg text-white",
        nested && "z-[60]",
        className,
      )}
      {...props}
    >
      {children}
      <DialogPrimitive.Close className="absolute right-4 top-4 rounded-sm opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-gray-600 focus:ring-offset-2 disabled:pointer-events-none text-gray-400 hover:text-white">
        <X className="h-4 w-4" />
        <span className="sr-only">Close</span>
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPortal>
));
DialogContent.displayName = DialogPrimitive.Content.displayName;

const DialogHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col space-y-1.5 text-center sm:text-left",
      className,
    )}
    {...props}
  />
);
DialogHeader.displayName = "DialogHeader";

const DialogFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2",
      className,
    )}
    {...props}
  />
);
DialogFooter.displayName = "DialogFooter";

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn(
      "text-lg font-semibold leading-none tracking-tight",
      className,
    )}
    {...props}
  />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-sm text-gray-400", className)}
    {...props}
  />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogClose,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
};
