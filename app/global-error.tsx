"use client";

/**
 * Last-resort boundary for a throw in the ROOT LAYOUT itself — the one place `app/error.tsx` cannot
 * cover, because it renders inside that layout. It therefore has to supply its own <html>/<body>,
 * and it only ever runs in production (in dev Next shows its own overlay instead).
 *
 * Deliberately minimal and dependency-free: whatever broke may well be ClerkProvider, the font
 * loader, or Providers, so this must not rely on any of them.
 */

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body style={{ background: "#111827", color: "#e5e7eb", margin: 0 }}>
        <div
          style={{
            minHeight: "100vh",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
            fontFamily: "system-ui, sans-serif",
          }}
        >
          <div style={{ maxWidth: 480 }}>
            <h1 style={{ fontSize: 18, fontWeight: 600, color: "#fde68a" }}>
              LiveOne couldn’t start
            </h1>
            <p style={{ marginTop: 8, color: "#fde68ab3", lineHeight: 1.5 }}>
              Something failed before the page could load. Reloading usually
              clears it.
            </p>
            <button
              onClick={reset}
              style={{
                marginTop: 16,
                padding: "6px 12px",
                fontSize: 14,
                borderRadius: 8,
                background: "#374151",
                color: "#d1d5db",
                border: "1px solid #4b5563",
                cursor: "pointer",
              }}
            >
              Try again
            </button>
            {error.digest && (
              <p style={{ marginTop: 16, fontSize: 12, color: "#6b7280" }}>
                Reference: {error.digest}
              </p>
            )}
          </div>
        </div>
      </body>
    </html>
  );
}
