/**
 * Polling service for fetching Selectronic data every minute
 */

import { SelectronicFetchClient } from './selectronic-fetch-client';
import { SelectronicData, ApiResponse } from '@/config';

type DataCallback = (data: SelectronicData) => void;
type ErrorCallback = (error: string) => void;
type StatusCallback = (status: 'connecting' | 'connected' | 'disconnected' | 'error') => void;

export class PollingService {
  private client: SelectronicFetchClient;
  private intervalId?: NodeJS.Timeout;
  private isRunning: boolean = false;
  private lastData?: SelectronicData;
  private lastError?: string;
  private lastFetchTime?: Date;
  
  // Callbacks
  private onData?: DataCallback;
  private onError?: ErrorCallback;
  private onStatusChange?: StatusCallback;

  constructor() {
    this.client = new SelectronicFetchClient();
  }

  /**
   * Start polling for data
   */
  async start(
    intervalMs: number = 60000, // Default 1 minute
    callbacks?: {
      onData?: DataCallback;
      onError?: ErrorCallback;
      onStatusChange?: StatusCallback;
    }
  ): Promise<void> {
    if (this.isRunning) {
      console.log('[Polling] Already running');
      return;
    }

    // Set callbacks
    if (callbacks) {
      this.onData = callbacks.onData;
      this.onError = callbacks.onError;
      this.onStatusChange = callbacks.onStatusChange;
    }

    console.log(`[Polling] Starting with ${intervalMs}ms interval`);
    this.isRunning = true;
    this.onStatusChange?.('connecting');

    // Authenticate first
    const authSuccess = await this.client.authenticate();
    if (!authSuccess) {
      console.error('[Polling] Authentication failed');
      this.onStatusChange?.('error');
      this.onError?.('Authentication failed');
      this.isRunning = false;
      return;
    }

    this.onStatusChange?.('connected');
    
    // Fetch immediately
    await this.fetchData();

    // Then set up interval
    this.intervalId = setInterval(() => {
      this.fetchData();
    }, intervalMs);

    console.log('[Polling] Service started');
  }

  /**
   * Stop polling
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
    this.isRunning = false;
    this.onStatusChange?.('disconnected');
    console.log('[Polling] Service stopped');
  }

  /**
   * Fetch data once
   */
  async fetchData(): Promise<void> {
    try {
      console.log(`[Polling] Fetching data at ${new Date().toLocaleTimeString()}`);
      
      const result: ApiResponse<SelectronicData> = await this.client.fetchData();
      
      if (result.success && result.data) {
        this.lastData = result.data;
        this.lastFetchTime = new Date();
        this.lastError = undefined;
        
        console.log(`[Polling] Data received - Solar: ${result.data.solarW}W, Battery: ${result.data.batterySOC}%`);
        
        this.onData?.(result.data);
        
        // Update status if needed
        if (this.onStatusChange) {
          this.onStatusChange('connected');
        }
      } else {
        const error = result.error || 'Unknown error';
        console.error('[Polling] Fetch failed:', error);
        
        this.lastError = error;
        this.onError?.(error);
        
        // Don't change to error status for transient failures
        // Only for auth failures
        if (error.includes('Auth')) {
          this.onStatusChange?.('error');
        }
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      console.error('[Polling] Exception:', errorMsg);
      
      this.lastError = errorMsg;
      this.onError?.(errorMsg);
    }
  }

  /**
   * Get last fetched data
   */
  getLastData(): SelectronicData | undefined {
    return this.lastData;
  }

  /**
   * Get last error
   */
  getLastError(): string | undefined {
    return this.lastError;
  }

  /**
   * Get last fetch time
   */
  getLastFetchTime(): Date | undefined {
    return this.lastFetchTime;
  }

  /**
   * Check if service is running
   */
  isActive(): boolean {
    return this.isRunning;
  }
}