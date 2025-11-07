"use client";

import { useEffect, useState } from "react";
import EnergyFlowSankey from "@/components/EnergyFlowSankey";
import { EnergyFlowMatrix } from "@/lib/energy-flow-matrix";

export default function TestSankeyPage() {
  const [matrix, setMatrix] = useState<EnergyFlowMatrix | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Fetch and process data for system 6, 1 day period
    (async () => {
      try {
        const { fetchAndProcessMondoData } = await import(
          "@/lib/mondo-data-processor"
        );
        const { calculateEnergyFlowMatrix } = await import(
          "@/lib/energy-flow-matrix"
        );

        const processedData = await fetchAndProcessMondoData("6", "1D");

        if (!processedData.generation || !processedData.load) {
          throw new Error("No generation or load data available");
        }

        const calculatedMatrix = calculateEnergyFlowMatrix(processedData);

        if (!calculatedMatrix) {
          throw new Error("Failed to calculate energy flow matrix");
        }

        setMatrix(calculatedMatrix);
        setLoading(false);
      } catch (err: any) {
        console.error("Error loading data:", err);
        setError(err.message);
        setLoading(false);
      }
    })();
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-lg">Loading energy flow data...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-lg text-red-600">Error: {error}</div>
      </div>
    );
  }

  if (!matrix) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-lg">No data available</div>
      </div>
    );
  }

  return (
    <div className="container mx-auto p-8">
      <h1 className="text-3xl font-bold mb-6">Energy Flow Sankey Diagram</h1>
      <p className="text-gray-600 mb-6">
        System 6 - Last 24 Hours | Total: {matrix.totalEnergy.toFixed(1)} kWh
      </p>

      <EnergyFlowSankey matrix={matrix} width={600} height={680} />
    </div>
  );
}
