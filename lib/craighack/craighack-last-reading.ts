import { roundToThree } from '@/lib/format-opennem';
import { getLastReading as getSelectronicLastReading } from '@/lib/selectronic/selectronic-last-reading';
import { getLastReading as getEnphaseLastReading } from '@/lib/enphase/enphase-last-reading';

/**
 * Fetch data from systems 2 and 3 and combine results
 * Solar data from systemId=3 (Enphase), battery/load/grid from systemId=2 (Selectronic)
 */
export async function getLastReading(systemId: number) {
  try {
    // Fetch data directly using the same functions the API uses
    const solarData = await getEnphaseLastReading(3);  // System 3 is Enphase
    const batteryData = await getSelectronicLastReading(2);  // System 2 is Selectronic
    
    if (!solarData) {
      console.error('[Craighack] No solar data available from system 3');
      return null;
    }
    
    if (!batteryData) {
      console.error('[Craighack] No battery/load/grid data available from system 2');
      return null;
    }
    
    // Combine the data - solar from system 3, everything else from system 2
    const combinedData = {
      timestamp: batteryData.timestamp,
      receivedTime: batteryData.receivedTime,
      power: {
        solarW: solarData.power.solarW,
        solarInverterW: batteryData.power.solarInverterW, // From system 2
        shuntW: batteryData.power.shuntW, // From system 2
        loadW: batteryData.power.loadW,
        batteryW: batteryData.power.batteryW,
        gridW: batteryData.power.gridW,
      },
      soc: {
        battery: batteryData.soc.battery,
      },
      energy: {
        today: {
          // Solar from Enphase (system 3), everything else from Selectronic (system 2)
          solarKwh: roundToThree(solarData.energy.today.solarKwh),
          loadKwh: roundToThree(batteryData.energy.today.loadKwh),
          batteryInKwh: roundToThree(batteryData.energy.today.batteryInKwh),
          batteryOutKwh: roundToThree(batteryData.energy.today.batteryOutKwh),
          gridInKwh: roundToThree(batteryData.energy.today.gridInKwh),
          gridOutKwh: roundToThree(batteryData.energy.today.gridOutKwh),
        },
      },
      system: {
        // System info from system 2 (Selectronic)
        faultCode: batteryData.system.faultCode,
        faultTimestamp: batteryData.system.faultTimestamp,
        generatorStatus: batteryData.system.generatorStatus,
      },
    };
    
    console.log('[Craighack] Combined data -',
      'Solar:', combinedData.power.solarW, 'W (from system 3)',
      'Load:', combinedData.power.loadW, 'W (from system 2)',
      'Battery:', combinedData.power.batteryW, 'W (from system 2)',
      'SOC:', combinedData.soc.battery?.toFixed(1) ?? 'N/A', '%');
    
    return combinedData;
  } catch (error) {
    console.error('[Craighack] Error fetching combined data:', error);
    return null;
  }
}