"use client";

import { useState, useRef } from "react";
import { useRouter } from "next/navigation";
import DashboardHeader from "@/components/DashboardHeader";

interface AvailableSystem {
  id: number;
  displayName: string;
  vendorSiteId: string;
  ownerClerkUserId?: string | null;
  alias?: string | null;
  ownerUsername?: string | null;
}

interface AmberSyncProps {
  systemIdentifier: string; // For display/routing purposes
  system: {
    id: number;
    displayName: string;
  };
  userId: string;
  isAdmin: boolean;
  availableSystems: AvailableSystem[];
}

export default function AmberSync({
  systemIdentifier,
  system,
  userId,
  isAdmin,
  availableSystems,
}: AmberSyncProps) {
  const router = useRouter();
  const [action, setAction] = useState<"usage" | "pricing" | "both">("both");
  const [startDate, setStartDate] = useState(() => {
    // Get today's date in AEST (UTC+10)
    const now = new Date();
    const aestOffset = 10 * 60; // AEST is UTC+10
    const localOffset = now.getTimezoneOffset();
    const aestTime = new Date(
      now.getTime() + (aestOffset + localOffset) * 60 * 1000,
    );
    return aestTime.toISOString().split("T")[0];
  });
  const [days, setDays] = useState<number | "">(1);
  const [dryRun, setDryRun] = useState(false);
  const [showSample, setShowSample] = useState(false);
  const [output, setOutput] = useState<
    Array<{ text: string; emphasis: boolean; heading?: 0 | 1 | 2 }>
  >([]);
  const [isRunning, setIsRunning] = useState(false);
  const outputRef = useRef<HTMLDivElement>(null);

  const isDaysValid = typeof days === "number" && days >= 1 && days <= 7;

  const renderHeader = (text: string, level: 0 | 1 | 2) => {
    const width = 80;

    if (level === 0) {
      // Boxed format
      const padding = Math.max(0, width - text.length - 2);
      const leftPad = Math.floor(padding / 2);
      const rightPad = padding - leftPad;
      const paddedText = " ".repeat(leftPad) + text + " ".repeat(rightPad);

      return [
        "╔" + "═".repeat(width - 2) + "╗",
        "║" + paddedText + "║",
        "╚" + "═".repeat(width - 2) + "╝",
      ].join("\n");
    } else if (level === 1) {
      // Level 1: single-line box drawing characters
      const topBorder = "┌" + "─".repeat(width - 2) + "┐";
      const bottomBorder = "└" + "─".repeat(width - 2) + "┘";
      const padding = Math.max(0, width - text.length - 2); // -2 for the │ characters
      const leftPad = Math.floor(padding / 2);
      const rightPad = padding - leftPad;
      const textLine =
        "│" + " ".repeat(leftPad) + text + " ".repeat(rightPad) + "│";
      return "\n" + topBorder + "\n" + textLine + "\n" + bottomBorder + "\n";
    } else {
      // Level 2: simple box with + corners and | sides
      const topBorder = "+" + "-".repeat(width - 2) + "+";
      const bottomBorder = "+" + "-".repeat(width - 2) + "+";
      const padding = Math.max(0, width - text.length - 2); // -2 for the | characters
      const leftPad = Math.floor(padding / 2);
      const rightPad = padding - leftPad;
      const textLine =
        "|" + " ".repeat(leftPad) + text + " ".repeat(rightPad) + "|";
      return "\n" + topBorder + "\n" + textLine + "\n" + bottomBorder + "\n";
    }
  };

  const handleSync = async () => {
    if (isRunning || !isDaysValid) return;

    setOutput([]);
    setIsRunning(true);

    try {
      const response = await fetch("/api/admin/amber-sync", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          systemIdentifier,
          action,
          startDate,
          days,
          dryRun,
          showSample,
        }),
      });

      if (!response.ok) {
        setOutput([{ text: `ERROR: ${response.statusText}`, emphasis: false }]);
        setIsRunning(false);
        return;
      }

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();

      if (!reader) {
        setOutput([{ text: "ERROR: No response stream", emphasis: false }]);
        setIsRunning(false);
        return;
      }

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value);
        const lines = chunk.split("\n");

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const data = JSON.parse(line.substring(6));
              if (data.text) {
                setOutput((prev) => [
                  ...prev,
                  {
                    text: data.text,
                    emphasis: data.emphasis || false,
                    heading: data.heading,
                  },
                ]);
              }
            } catch (e) {
              // Ignore parse errors
            }
          }
        }
      }
    } catch (error) {
      setOutput((prev) => [
        ...prev,
        {
          text: `\nERROR: ${error instanceof Error ? error.message : "Unknown error"}`,
          emphasis: false,
        },
      ]);
    } finally {
      setIsRunning(false);
    }
  };

  const handleLogout = () => {
    router.push("/sign-in");
  };

  return (
    <div className="min-h-screen bg-gray-900 text-gray-200">
      {/* Header */}
      <DashboardHeader
        displayName={`${system.displayName} — Amber Sync`}
        systemId={system.id.toString()}
        lastUpdate={null}
        isAdmin={isAdmin}
        userId={userId}
        availableSystems={availableSystems}
        onLogout={handleLogout}
      />

      <div
        className="terminal-container"
        style={{
          backgroundColor: "#000000",
          color: "#33cc33",
          fontFamily: "'SF Mono', 'Monaco', 'Courier New', monospace",
          fontSize: "11px",
          minHeight: "calc(100vh - 64px)", // Account for header height
          padding: "20px",
          position: "relative",
          cursor: isRunning ? "wait" : "default",
        }}
      >
        <div style={{ position: "relative", zIndex: 2 }}>
          {/* Title */}
          <pre
            style={{
              textShadow: "0 0 3px rgba(51, 204, 51, 0.3)",
              marginBottom: "20px",
            }}
          >
            {renderHeader("AMBER ELECTRIC DATA SYNC TERMINAL", 0)}
          </pre>

          {/* Controls */}
          <div style={{ marginBottom: "30px" }}>
            <div style={{ marginBottom: "15px" }}>
              <div>
                <pre style={{ margin: 0, display: "inline" }}>
                  {"UPDATE:     "}
                </pre>
                <button
                  onClick={() => setAction("usage")}
                  disabled={isRunning}
                  style={{
                    background: "transparent",
                    border: "none",
                    color: "#33cc33",
                    fontFamily: "'SF Mono', 'Monaco', 'Courier New', monospace",
                    cursor: isRunning ? "not-allowed" : "pointer",
                    padding: 0,
                    opacity: isRunning ? 0.5 : 1,
                  }}
                >
                  [{action === "usage" ? "X" : " "}] USAGE
                </button>
              </div>
              <div>
                <pre style={{ margin: 0, display: "inline" }}>
                  {"            "}
                </pre>
                <button
                  onClick={() => setAction("pricing")}
                  disabled={isRunning}
                  style={{
                    background: "transparent",
                    border: "none",
                    color: "#33cc33",
                    fontFamily: "'SF Mono', 'Monaco', 'Courier New', monospace",
                    cursor: isRunning ? "not-allowed" : "pointer",
                    padding: 0,
                    opacity: isRunning ? 0.5 : 1,
                  }}
                >
                  [{action === "pricing" ? "X" : " "}] PRICING
                </button>
              </div>
              <div>
                <pre style={{ margin: 0, display: "inline" }}>
                  {"            "}
                </pre>
                <button
                  onClick={() => setAction("both")}
                  disabled={isRunning}
                  style={{
                    background: "transparent",
                    border: "none",
                    color: "#33cc33",
                    fontFamily: "'SF Mono', 'Monaco', 'Courier New', monospace",
                    cursor: isRunning ? "not-allowed" : "pointer",
                    padding: 0,
                    opacity: isRunning ? 0.5 : 1,
                  }}
                >
                  [{action === "both" ? "X" : " "}] BOTH
                </button>
              </div>
            </div>

            <div style={{ marginBottom: "15px" }}>
              <pre style={{ margin: 0, display: "inline" }}>
                {"PERIOD:     "}
              </pre>
              START:{" "}
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !isRunning && isDaysValid) {
                    handleSync();
                  }
                }}
                disabled={isRunning}
                style={{
                  backgroundColor: "#000000",
                  color: "#33cc33",
                  border: "1px solid #33cc33",
                  fontFamily: "'SF Mono', 'Monaco', 'Courier New', monospace",
                  fontSize: "11px",
                  padding: "2px 4px",
                  opacity: isRunning ? 0.5 : 1,
                }}
              />{" "}
              DAYS:{" "}
              <input
                type="number"
                value={days}
                onChange={(e) => {
                  const val = e.target.value;
                  if (val === "") {
                    setDays("");
                  } else {
                    const num = parseInt(val, 10);
                    if (!isNaN(num)) {
                      setDays(num);
                    }
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !isRunning && isDaysValid) {
                    handleSync();
                  }
                }}
                disabled={isRunning}
                style={{
                  backgroundColor: "#000000",
                  color: "#33cc33",
                  border: "1px solid #33cc33",
                  fontFamily: "'SF Mono', 'Monaco', 'Courier New', monospace",
                  fontSize: "11px",
                  padding: "2px 4px",
                  width: "3ch",
                  opacity: isRunning ? 0.5 : 1,
                  MozAppearance: "textfield",
                }}
                className="no-spinner"
              />{" "}
              (MAX 7)
            </div>

            <div style={{ marginBottom: "20px" }}>
              <div>
                <pre style={{ margin: 0, display: "inline" }}>
                  {"OPTIONS:    "}
                </pre>
                <button
                  onClick={() => setDryRun(!dryRun)}
                  disabled={isRunning}
                  style={{
                    background: "transparent",
                    border: "none",
                    color: "#33cc33",
                    fontFamily: "'SF Mono', 'Monaco', 'Courier New', monospace",
                    cursor: isRunning ? "not-allowed" : "pointer",
                    padding: 0,
                    opacity: isRunning ? 0.5 : 1,
                  }}
                >
                  [{dryRun ? "X" : " "}] DRY RUN
                </button>
              </div>
              <div>
                <pre style={{ margin: 0, display: "inline" }}>
                  {"            "}
                </pre>
                <button
                  onClick={() => setShowSample(!showSample)}
                  disabled={isRunning}
                  style={{
                    background: "transparent",
                    border: "none",
                    color: "#33cc33",
                    fontFamily: "'SF Mono', 'Monaco', 'Courier New', monospace",
                    cursor: isRunning ? "not-allowed" : "pointer",
                    padding: 0,
                    opacity: isRunning ? 0.5 : 1,
                  }}
                >
                  [{showSample ? "X" : " "}] SHOW SAMPLES
                </button>
              </div>
            </div>

            <div>
              <pre style={{ margin: 0 }}>
                {"                                  "}
                <button
                  onClick={handleSync}
                  disabled={isRunning || !isDaysValid}
                  style={{
                    background: "transparent",
                    border: "none",
                    color: "#33cc33",
                    fontFamily: "'SF Mono', 'Monaco', 'Courier New', monospace",
                    cursor:
                      isRunning || !isDaysValid ? "not-allowed" : "pointer",
                    padding: 0,
                    textShadow: "0 0 3px rgba(51, 204, 51, 0.3)",
                    opacity: isRunning || !isDaysValid ? 0.5 : 1,
                  }}
                >
                  {`┌──────────┐
│   SYNC   │
└──────────┘`}
                </button>
              </pre>
            </div>
          </div>

          {/* Terminal Output */}
          <div
            ref={outputRef}
            style={{
              color: "#33cc33",
              fontFamily: "'SF Mono', 'Monaco', 'Courier New', monospace",
              whiteSpace: "pre",
              textShadow: "0 0 3px rgba(51, 204, 51, 0.3)",
              paddingBottom: "20px",
            }}
          >
            {output.length === 0 ? (
              "Ready. Press SYNC to begin..."
            ) : (
              <>
                {output.map((chunk, idx) => (
                  <span
                    key={idx}
                    style={{
                      color: chunk.emphasis ? "#00ff00" : "#218221",
                      fontWeight: chunk.emphasis ? "bold" : "normal",
                    }}
                  >
                    {chunk.heading !== undefined
                      ? renderHeader(chunk.text, chunk.heading)
                      : chunk.text}
                    {"\n"}
                  </span>
                ))}
              </>
            )}
            {"\n"}
            <span className="cursor">_</span>
          </div>

          <style jsx global>{`
            .terminal-container::before {
              content: "";
              position: fixed;
              top: 0;
              left: 0;
              right: 0;
              bottom: 0;
              background: repeating-linear-gradient(
                0deg,
                rgba(0, 0, 0, 0.4) 0px,
                rgba(0, 0, 0, 0.4) 1px,
                transparent 1px,
                transparent 2px
              );
              pointer-events: none;
              z-index: 1000;
            }

            .cursor {
              animation: blink 1s step-start infinite;
            }

            @keyframes blink {
              50% {
                opacity: 0;
              }
            }

            .no-spinner::-webkit-outer-spin-button,
            .no-spinner::-webkit-inner-spin-button {
              -webkit-appearance: none;
              margin: 0;
            }
          `}</style>
        </div>
      </div>
    </div>
  );
}
