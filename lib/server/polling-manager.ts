/**
 * Server-side polling manager that runs when Next.js server starts
 * Manages polling for all registered users/devices
 */

import { SelectronicFetchClient, SystemInfo } from '../selectronic-fetch-client';
import { SelectronicData } from '@/config';
import { EventEmitter } from 'events';
import { db, systems, readings, pollingStatus, NewReading } from '@/lib/db';
import { eq, and } from 'drizzle-orm';

interface DeviceConfig {
  userId: string;
  email: string;
  password: string;
  systemNumber: string;
  intervalMs?: number;
}

interface PollInstance {
  client: SelectronicFetchClient;
  intervalId?: NodeJS.Timeout;
  lastData?: SelectronicData;
  lastError?: string;
  lastFetchTime?: Date;
  isAuthenticated: boolean;
  systemInfo?: SystemInfo;
  previousTotals?: {
    solar: number;
    load: number;
    batteryIn: number;
    batteryOut: number;
    gridIn: number;
    gridOut: number;
  };
}

class PollingManager extends EventEmitter {
  private static instance: PollingManager;
  private pollInstances: Map<string, PollInstance> = new Map();
  private isRunning: boolean = false;
  private dataStore: Map<string, SelectronicData> = new Map();

  private constructor() {
    super();
    console.log('[PollingManager] Initialized');
  }

  static getInstance(): PollingManager {
    if (!PollingManager.instance) {
      PollingManager.instance = new PollingManager();
    }
    return PollingManager.instance;
  }

  /**
   * Start the polling manager
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('[PollingManager] Already running');
      return;
    }

    console.log('[PollingManager] Starting...');
    this.isRunning = true;

    // In production, load devices from database
    // For MVP, just add Simon's device
    if (process.env.NODE_ENV === 'development') {
      await this.addDevice({
        userId: 'simon',
        email: process.env.SELECTRONIC_EMAIL || 'simon@holmesacourt',
        password: process.env.SELECTRONIC_PASSWORD || 'juztic-5semVa-fepguv',
        systemNumber: process.env.SELECTRONIC_SYSTEM || '1586',
        intervalMs: 60000, // 1 minute
      });
    }

    console.log('[PollingManager] Started with', this.pollInstances.size, 'devices');
  }

  /**
   * Stop all polling
   */
  stop(): void {
    console.log('[PollingManager] Stopping all polling...');
    
    for (const [key, instance] of this.pollInstances) {
      if (instance.intervalId) {
        clearInterval(instance.intervalId);
      }
    }
    
    this.pollInstances.clear();
    this.dataStore.clear();
    this.isRunning = false;
    
    console.log('[PollingManager] Stopped');
  }

  /**
   * Add a device to poll
   */
  async addDevice(config: DeviceConfig): Promise<boolean> {
    const key = `${config.userId}:${config.systemNumber}`;
    
    if (this.pollInstances.has(key)) {
      console.log(`[PollingManager] Device ${key} already exists`);
      return false;
    }

    console.log(`[PollingManager] Adding device ${key}`);

    const client = new SelectronicFetchClient({
      email: config.email,
      password: config.password,
      systemNumber: config.systemNumber,
    });

    const instance: PollInstance = {
      client,
      isAuthenticated: false,
    };

    // Try to authenticate
    try {
      const authSuccess = await client.authenticate();
      if (!authSuccess) {
        console.error(`[PollingManager] Authentication failed for ${key}`);
        return false;
      }
      instance.isAuthenticated = true;
      
      // Fetch system info after successful authentication
      console.log(`[PollingManager] Fetching system info for ${key}...`);
      const systemInfo = await client.fetchSystemInfo();
      if (systemInfo) {
        instance.systemInfo = systemInfo;
        console.log(`[PollingManager] System info for ${key}:`, systemInfo);
      }
    } catch (error) {
      console.error(`[PollingManager] Auth error for ${key}:`, error);
      return false;
    }

    // Start polling
    const intervalMs = config.intervalMs || 60000;
    
    // Fetch immediately
    this.fetchDataForDevice(key, instance);
    
    // Then set interval
    instance.intervalId = setInterval(() => {
      this.fetchDataForDevice(key, instance);
    }, intervalMs);

    this.pollInstances.set(key, instance);
    
    console.log(`[PollingManager] Device ${key} added, polling every ${intervalMs}ms`);
    return true;
  }

  /**
   * Remove a device from polling
   */
  removeDevice(userId: string, systemNumber: string): boolean {
    const key = `${userId}:${systemNumber}`;
    const instance = this.pollInstances.get(key);
    
    if (!instance) {
      return false;
    }

    if (instance.intervalId) {
      clearInterval(instance.intervalId);
    }
    
    this.pollInstances.delete(key);
    this.dataStore.delete(key);
    
    console.log(`[PollingManager] Device ${key} removed`);
    return true;
  }

  /**
   * Fetch data for a specific device
   */
  private async fetchDataForDevice(key: string, instance: PollInstance): Promise<void> {
    try {
      console.log(`[PollingManager] Fetching data for ${key} at ${new Date().toLocaleTimeString()}`);
      
      const result = await instance.client.fetchData();
      
      if (result.success && result.data) {
        instance.lastData = result.data;
        instance.lastFetchTime = new Date();
        instance.lastError = undefined;
        
        // Store in central data store
        this.dataStore.set(key, result.data);
        
        // Record to database
        await this.recordToDatabase(key, result.data);
        
        // Emit event for real-time updates
        this.emit('data', {
          key,
          data: result.data,
          timestamp: new Date(),
        });
        
        // Log energy deltas
        this.logEnergyDeltas(key, instance, result.data);
        
        console.log(`[PollingManager] ${key} - Solar: ${result.data.solarPower.toFixed(0)}W (Remote: ${result.data.solarInverterPower.toFixed(0)}W, Local: ${result.data.shuntPower.toFixed(0)}W), Battery: ${result.data.batterySOC.toFixed(1)}%`);
        
        // Check for faults
        if (result.data.faultCode !== 0) {
          console.warn(`[PollingManager] ${key} - FAULT CODE ${result.data.faultCode} at ${new Date(result.data.faultTimestamp * 1000).toLocaleString()}`);
        }
      } else {
        const error = result.error || 'Unknown error';
        instance.lastError = error;
        
        // Just log the error, don't emit event without handler
        console.error(`[PollingManager] ${key} fetch failed:`, error);
        
        // Re-authenticate if needed
        if (error.includes('401') || error.includes('Auth')) {
          console.log(`[PollingManager] Re-authenticating ${key}...`);
          instance.isAuthenticated = false;
          const authSuccess = await instance.client.authenticate();
          if (authSuccess) {
            instance.isAuthenticated = true;
            // Retry fetch
            await this.fetchDataForDevice(key, instance);
          }
        }
      }
    } catch (error) {
      console.error(`[PollingManager] Exception for ${key}:`, error);
      instance.lastError = error instanceof Error ? error.message : 'Unknown error';
    }
  }

  /**
   * Get latest data for a device
   */
  getLatestData(userId: string, systemNumber: string): SelectronicData | undefined {
    const key = `${userId}:${systemNumber}`;
    return this.dataStore.get(key);
  }

  /**
   * Get all latest data
   */
  getAllLatestData(): Map<string, SelectronicData> {
    return new Map(this.dataStore);
  }

  /**
   * Get device status
   */
  getDeviceStatus(userId: string, systemNumber: string): {
    isPolling: boolean;
    lastFetchTime?: Date;
    lastError?: string;
    isAuthenticated: boolean;
  } {
    const key = `${userId}:${systemNumber}`;
    const instance = this.pollInstances.get(key);
    
    if (!instance) {
      return {
        isPolling: false,
        isAuthenticated: false,
      };
    }

    return {
      isPolling: true,
      lastFetchTime: instance.lastFetchTime,
      lastError: instance.lastError,
      isAuthenticated: instance.isAuthenticated,
    };
  }

  /**
   * Get system info for a device
   */
  getSystemInfo(userId: string, systemNumber: string): SystemInfo | undefined {
    const key = `${userId}:${systemNumber}`;
    const instance = this.pollInstances.get(key);
    return instance?.systemInfo;
  }

  /**
   * Log energy deltas between polls
   */
  private logEnergyDeltas(key: string, instance: PollInstance, data: SelectronicData): void {
    const currentTotals = {
      solar: data.solarKwhTotal,
      load: data.loadKwhTotal,
      batteryIn: data.batteryInKwhTotal,
      batteryOut: data.batteryOutKwhTotal,
      gridIn: data.gridInKwhTotal,
      gridOut: data.gridOutKwhTotal,
    };
    
    if (instance.previousTotals) {
      const deltas = {
        solar: currentTotals.solar - instance.previousTotals.solar,
        load: currentTotals.load - instance.previousTotals.load,
        batteryIn: currentTotals.batteryIn - instance.previousTotals.batteryIn,
        batteryOut: currentTotals.batteryOut - instance.previousTotals.batteryOut,
        gridIn: currentTotals.gridIn - instance.previousTotals.gridIn,
        gridOut: currentTotals.gridOut - instance.previousTotals.gridOut,
      };
      
      // Always log to see patterns
      console.log(`[Energy Δ] ${key} - Solar: ${deltas.solar.toFixed(3)}Wh, Load: ${deltas.load.toFixed(3)}Wh, Batt In: ${deltas.batteryIn.toFixed(3)}Wh, Batt Out: ${deltas.batteryOut.toFixed(3)}Wh`);
    }
    
    instance.previousTotals = currentTotals;
  }

  /**
   * Record data to database
   */
  private async recordToDatabase(key: string, data: SelectronicData): Promise<void> {
    try {
      const [userId, systemNumber] = key.split(':');
      
      // Get or create system
      let system = await db.select()
        .from(systems)
        .where(and(
          eq(systems.userId, userId),
          eq(systems.systemNumber, systemNumber)
        ))
        .limit(1)
        .then(rows => rows[0]);
      
      if (!system) {
        // Create system
        const instance = this.pollInstances.get(key);
        const systemInfo = instance?.systemInfo;
        
        const [newSystem] = await db.insert(systems)
          .values({
            userId,
            systemNumber,
            displayName: `System ${systemNumber}`,
            model: systemInfo?.model,
            serial: systemInfo?.serial,
            ratings: systemInfo?.ratings,
            solarSize: systemInfo?.solarSize,
            batterySize: systemInfo?.batterySize,
          })
          .returning();
        
        system = newSystem;
        console.log(`[DB] Created system ${system.id} for ${key}`);
      }
      
      // Calculate delay
      const inverterTime = new Date(data.timestamp);
      const receivedTime = new Date();
      const delaySeconds = Math.floor((receivedTime.getTime() - inverterTime.getTime()) / 1000);
      
      // Insert reading
      const reading: NewReading = {
        systemId: system.id,
        inverterTime,
        receivedTime,
        delaySeconds,
        solarPower: data.solarPower,
        solarInverterPower: data.solarInverterPower,
        shuntPower: data.shuntPower,
        loadPower: data.loadPower,
        batteryPower: data.batteryPower,
        gridPower: data.gridPower,
        batterySOC: data.batterySOC,
        faultCode: data.faultCode,
        faultTimestamp: data.faultTimestamp,
        generatorStatus: data.generatorStatus,
        // Energy counters (kWh) - lifetime totals only, rounded to 3 decimal places
        solarKwhTotal: Math.round(data.solarKwhTotal * 1000) / 1000,
        loadKwhTotal: Math.round(data.loadKwhTotal * 1000) / 1000,
        batteryInKwhTotal: Math.round(data.batteryInKwhTotal * 1000) / 1000,
        batteryOutKwhTotal: Math.round(data.batteryOutKwhTotal * 1000) / 1000,
        gridInKwhTotal: Math.round(data.gridInKwhTotal * 1000) / 1000,
        gridOutKwhTotal: Math.round(data.gridOutKwhTotal * 1000) / 1000,
      };
      
      await db.insert(readings).values(reading);
      
      // Update polling status
      const existingStatus = await db.select()
        .from(pollingStatus)
        .where(eq(pollingStatus.systemId, system.id))
        .limit(1)
        .then(rows => rows[0]);
      
      if (existingStatus) {
        await db.update(pollingStatus)
          .set({
            lastPollTime: receivedTime,
            lastSuccessTime: receivedTime,
            consecutiveErrors: 0,
            totalPolls: existingStatus.totalPolls + 1,
            successfulPolls: existingStatus.successfulPolls + 1,
            updatedAt: receivedTime,
          })
          .where(eq(pollingStatus.systemId, system.id));
      } else {
        await db.insert(pollingStatus)
          .values({
            systemId: system.id,
            lastPollTime: receivedTime,
            lastSuccessTime: receivedTime,
            consecutiveErrors: 0,
            isActive: true,
            totalPolls: 1,
            successfulPolls: 1,
          });
      }
      
    } catch (error) {
      console.error('[DB] Failed to record data:', error);
    }
  }
}

export default PollingManager;

// Initialize and start the polling manager when this module is imported
// DISABLED for local testing - we don't want to poll locally
if (process.env.NODE_ENV === 'development' && false) {
  const manager = PollingManager.getInstance();
  
  // Start polling when server starts
  process.nextTick(async () => {
    console.log('[PollingManager] Auto-starting in development mode...');
    await manager.start();
  });

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('[PollingManager] Shutting down...');
    manager.stop();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    console.log('[PollingManager] Shutting down...');
    manager.stop();
    process.exit(0);
  });
}