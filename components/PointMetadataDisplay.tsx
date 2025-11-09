interface PointMetadataDisplayProps {
  vendorType?: string;
  vendorSiteId?: string | number;
  ownerUsername?: string;
  systemShortName?: string | null;
  systemId: number;
  originId: string;
  originSubId?: string | null;
  defaultName: string;
  pointDbId: number;
  subsystem?: string | null;
  metricType: string;
  metricUnit?: string | null;
  transform?: string | null;
}

export default function PointMetadataDisplay({
  vendorType,
  vendorSiteId,
  ownerUsername,
  systemShortName,
  systemId,
  originId,
  originSubId,
  defaultName,
  pointDbId,
  subsystem,
  metricType,
  metricUnit,
  transform,
}: PointMetadataDisplayProps) {
  return (
    <div className="border border-gray-600 rounded-md p-3 bg-gray-800/30">
      <div className="text-xs font-medium text-gray-400 mb-2">
        Original Metadata
      </div>

      {/* System */}
      {(vendorType || vendorSiteId || ownerUsername) && (
        <div className="flex items-center gap-3">
          <label className="text-sm font-medium text-gray-300 w-32 flex-shrink-0">
            System:
          </label>
          <div className="px-2 font-mono text-sm flex-1 whitespace-nowrap">
            <span className="text-gray-300">
              {vendorType || "N/A"}/{vendorSiteId || "N/A"}
            </span>
            {ownerUsername && (
              <span className="text-gray-400">
                {" "}
                ({ownerUsername}/{systemShortName || systemId})
              </span>
            )}
          </div>
        </div>
      )}

      {/* Point */}
      <div className="flex items-center gap-3">
        <label className="text-sm font-medium text-gray-300 w-32 flex-shrink-0">
          Point:
        </label>
        <div className="px-2 font-mono text-sm flex-1">
          <span className="text-gray-300 whitespace-nowrap">{originId}</span>
          <span className="text-gray-400 whitespace-nowrap">
            {" "}
            ({defaultName})
          </span>
          <span className="text-gray-500 whitespace-nowrap">
            {" "}
            ID: {systemId}.{pointDbId}
          </span>
        </div>
      </div>

      {/* Sub-Point */}
      <div className="flex items-center gap-3">
        <label className="text-sm font-medium text-gray-300 w-32 flex-shrink-0">
          Sub-Point:
        </label>
        <div className="px-2 text-gray-400 font-mono text-sm flex-1 flex items-center gap-2">
          <span>{originSubId || "N/A"}</span>
          {transform === "d" && (
            <span className="px-2 py-0.5 bg-blue-500/20 text-blue-300 text-xs rounded-md border border-blue-500/30">
              DIFFERENTIATED
            </span>
          )}
          {transform === "i" && (
            <span className="px-2 py-0.5 bg-orange-500/20 text-orange-300 text-xs rounded-md border border-orange-500/30">
              INVERTED
            </span>
          )}
        </div>
      </div>

      {/* Subsystem */}
      <div className="flex items-center gap-3">
        <label className="text-sm font-medium text-gray-300 w-32 flex-shrink-0">
          Subsystem:
        </label>
        <div className="px-2 text-gray-400 text-sm flex-1">
          {subsystem || "N/A"}
        </div>
      </div>

      {/* Type and unit */}
      <div className="flex items-center gap-3">
        <label className="text-sm font-medium text-gray-300 w-32 flex-shrink-0">
          Type and unit:
        </label>
        <div className="px-2 text-gray-400 text-sm flex-1">
          {metricType}
          {metricUnit && ` (${metricUnit})`}
        </div>
      </div>
    </div>
  );
}
