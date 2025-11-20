"use client";

import { useState } from "react";
import { ChevronRight, ChevronDown, Copy, Check } from "lucide-react";
import { JsonView, darkStyles } from "react-json-view-lite";
import "react-json-view-lite/dist/index.css";

interface JsonViewerProps {
  data: any;
  label?: string;
}

export default function JsonViewer({
  data,
  label = "Raw Comms",
}: JsonViewerProps) {
  const [showJson, setShowJson] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(JSON.stringify(data, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Custom styles to override the greenish background while keeping structure
  const customStyles = {
    ...darkStyles,
    container: "bg-transparent", // Remove greenish background, inherit from parent
    label: "font-normal text-white", // Remove bold from labels and make them white
  };

  return (
    <div>
      <button
        onClick={() => setShowJson(!showJson)}
        className="flex items-center gap-2 text-sm text-gray-400 hover:text-white transition-colors"
      >
        {showJson ? (
          <ChevronDown className="w-4 h-4" />
        ) : (
          <ChevronRight className="w-4 h-4" />
        )}
        {label}
      </button>

      {showJson && (
        <div className="mt-3 bg-gray-900 rounded-lg relative p-2">
          <button
            onClick={handleCopy}
            className="absolute top-3 right-3 p-2 bg-gray-800/90 hover:bg-gray-700 border border-gray-600 rounded-md transition-colors z-20 shadow-lg"
            title="Copy JSON"
          >
            {copied ? (
              <Check className="w-4 h-4 text-green-400" />
            ) : (
              <Copy className="w-4 h-4 text-gray-400" />
            )}
          </button>
          <div className="overflow-x-auto font-mono text-xs whitespace-pre">
            <JsonView
              data={data}
              shouldExpandNode={() => true}
              style={customStyles}
            />
          </div>
        </div>
      )}
    </div>
  );
}
