"use client";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertCircle, Info, X } from "lucide-react";

export interface ControlNoticeValue {
  /** `info` is reassurance ("the car was already charging") and must never wear red. */
  tone: "info" | "error";
  text: string;
}

/**
 * The command plane's one feedback surface: a dismissible inline notice.
 *
 * Exists so a benign vendor decline and a real failure stop sharing the destructive-red Alert —
 * the tones differ, the affordance (read it, dismiss it) doesn't. Shared by the charge dialog
 * and the limits block so the two can't drift apart visually.
 */
export default function ControlNotice({
  notice,
  onDismiss,
}: {
  notice: ControlNoticeValue | null;
  onDismiss: () => void;
}) {
  if (!notice) return null;
  const isError = notice.tone === "error";
  return (
    <Alert
      variant={isError ? "destructive" : "default"}
      className={isError ? "pr-9" : "pr-9 border-gray-600 text-gray-200"}
    >
      {isError ? (
        <AlertCircle className="h-4 w-4" />
      ) : (
        <Info className="h-4 w-4" />
      )}
      <AlertDescription>{notice.text}</AlertDescription>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={onDismiss}
        className="absolute right-2 top-2 rounded p-1 text-current opacity-60 transition-opacity hover:opacity-100"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </Alert>
  );
}
