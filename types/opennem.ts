// OpenNEM data format types

export interface OpenNEMHistoryData {
  start: string;        // e.g., "2025-08-09T00:00:00"
  last: string;         // e.g., "2025-08-16T12:00:00"
  interval: string;     // e.g., "1m", "1d", "1w", "1M"
  data: (number | null)[];
}

export interface OpenNEMDataSeries {
  id: string;
  type: string;
  units: string;
  history: OpenNEMHistoryData;
  network?: string;
  source?: string;
  description?: string;
  note?: string;
}

export interface OpenNEMResponse {
  type: string;
  version: string;
  network: string;
  created_at: string;
  requestStart?: string;  // Start of requested time range
  requestEnd?: string;    // End of requested time range
  data: OpenNEMDataSeries[];
}

// Interval types we'll support
export type DataInterval = '1m' | '1d' | '1w' | '1M';

export interface HistoricalDataRequest {
  interval: DataInterval;
  fields?: string[];  // Which fields to include (e.g., ['solar', 'load', 'battery'])
}