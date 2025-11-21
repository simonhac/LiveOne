"use client";

import { useState, useRef } from "react";
import { useParams } from "next/navigation";

export default function AmberSyncPage() {
  const params = useParams();
  const systemIdentifier = params.systemIdentifier as string;
  const [action, setAction] = useState<"usage" | "pricing" | "both">("both");
  const [startDate, setStartDate] = useState(() => {
    // Start from 12 hours before now
    const start = new Date();
    start.setHours(start.getHours() - 12);
    return start.toISOString().split("T")[0];
  });
  const [days, setDays] = useState<number | "">(2); // 12h before + 18h after = 30h ~= 2 days
  const [dryRun, setDryRun] = useState(true);
  const [showSample, setShowSample] = useState(false);
  const [output, setOutput] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const outputRef = useRef<HTMLDivElement>(null);

  const isDaysValid = typeof days === "number" && days >= 1 && days <= 30;

  const handleSync = async () => {
    if (isRunning || !isDaysValid) return;

    setOutput("");
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
        setOutput(`ERROR: ${response.statusText}\n`);
        setIsRunning(false);
        return;
      }

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();

      if (!reader) {
        setOutput("ERROR: No response stream\n");
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
                setOutput((prev) => prev + data.text + "\n");
              }
            } catch (e) {
              // Ignore parse errors
            }
          }
        }
      }
    } catch (error) {
      setOutput(
        (prev) =>
          prev +
          `\nERROR: ${error instanceof Error ? error.message : "Unknown error"}\n`,
      );
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <div
      className="terminal-container"
      style={{
        backgroundColor: "#000000",
        color: "#33cc33",
        fontFamily: "'SF Mono', 'Monaco', 'Courier New', monospace",
        fontSize: "11px",
        minHeight: "100vh",
        padding: "20px",
        position: "relative",
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
          {`╔══════════════════════════════════════════════════════════════════════════════╗
║                     AMBER ELECTRIC DATA SYNC TERMINAL                        ║
╚══════════════════════════════════════════════════════════════════════════════╝`}
        </pre>

        {/* Controls */}
        <div style={{ marginBottom: "30px" }}>
          <div style={{ marginBottom: "15px" }}>
            UPDATE:{" "}
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
            </button>{" "}
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
            </button>{" "}
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

          <div style={{ marginBottom: "15px" }}>
            START DATE:{" "}
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
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
              disabled={isRunning}
              style={{
                backgroundColor: "#000000",
                color: "#33cc33",
                border: "1px solid #33cc33",
                fontFamily: "'SF Mono', 'Monaco', 'Courier New', monospace",
                fontSize: "11px",
                padding: "2px 4px",
                width: "50px",
                opacity: isRunning ? 0.5 : 1,
                MozAppearance: "textfield",
              }}
              className="no-spinner"
            />{" "}
            (MAX 30)
          </div>

          <div style={{ marginBottom: "20px" }}>
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
                marginRight: "20px",
                opacity: isRunning ? 0.5 : 1,
              }}
            >
              [{dryRun ? "X" : " "}] DRY RUN
            </button>
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

          <button
            onClick={handleSync}
            disabled={isRunning || !isDaysValid}
            style={{
              background: "transparent",
              border: "none",
              color: "#33cc33",
              fontFamily: "'SF Mono', 'Monaco', 'Courier New', monospace",
              cursor: isRunning || !isDaysValid ? "not-allowed" : "pointer",
              padding: 0,
              textShadow: "0 0 3px rgba(51, 204, 51, 0.3)",
              opacity: isRunning || !isDaysValid ? 0.5 : 1,
            }}
          >
            <pre style={{ margin: 0 }}>
              {`┌──────────┐
│   SYNC   │
└──────────┘`}
            </pre>
          </button>
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
          {output || "Ready. Press SYNC to begin..."}
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
  );
}
