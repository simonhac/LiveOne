import * as SunCalc from 'suncalc';

// Type for systems we've already validated have an owner
interface EnphaseSystemWithOwner {
  id: number;
  vendorSiteId: string;
  ownerClerkUserId: string;
  timezoneOffsetMin: number;
  location: any;
}

export interface PollingScheduleResult {
  shouldPollNow: boolean;
  skipReason?: string;
  nextPollTimeStr?: string;
}

/**
 * Check if we should poll an Enphase system based on smart schedule
 * Poll every 30 mins from 30 mins after dawn to 30 mins after dusk,
 * then hourly from 01:00-05:00 for yesterday's data
 */
export function checkEnphasePollingSchedule(
  system: EnphaseSystemWithOwner, 
  lastPollTime: Date | null,
  currentTime: Date = new Date()
): PollingScheduleResult {
  // Always poll if never polled before
  if (!lastPollTime) {
    console.log(`[ENPHASE] Never polled, polling now`);
    return { shouldPollNow: true };
  }
  
  // Get location for sunrise/sunset calculation
  let lat = -37.8136; // Melbourne default
  let lon = 144.9631;
  
  if (system.location) {
    try {
      const loc = typeof system.location === 'string' 
        ? JSON.parse(system.location) 
        : system.location;
      if (loc.lat && loc.lon) {
        lat = loc.lat;
        lon = loc.lon;
      }
    } catch (e) {
      console.log(`[ENPHASE] Using default location`);
    }
  }
  
  // Calculate local time for the system
  // Note: timezoneOffsetMin is minutes AHEAD of UTC (positive for east of UTC)
  const utcTime = currentTime.getTime();
  const localOffset = system.timezoneOffsetMin * 60 * 1000;
  const localTime = new Date(utcTime + localOffset);
  const localHour = localTime.getUTCHours(); // Use UTC methods since we manually applied offset
  const localMinutes = localTime.getUTCMinutes();
  const localTimeMinutes = localHour * 60 + localMinutes;
  
  // Calculate sun times for today (SunCalc returns times in UTC)
  const sunTimes = SunCalc.getTimes(currentTime, lat, lon);
  
  // Dawn and dusk in UTC
  const dawnUTC = sunTimes.dawn;
  const duskUTC = sunTimes.dusk;
  
  // Convert UTC times to minutes since midnight in local time
  // We need to handle the fact that dawn/dusk might cross midnight boundary
  const dawnLocalTime = new Date(dawnUTC.getTime() + localOffset);
  const duskLocalTime = new Date(duskUTC.getTime() + localOffset);
  
  // Get minutes since midnight for each (using UTC methods since we applied offset)
  let dawnMinutes = dawnLocalTime.getUTCHours() * 60 + dawnLocalTime.getUTCMinutes();
  let duskMinutes = duskLocalTime.getUTCHours() * 60 + duskLocalTime.getUTCMinutes();
  
  // If dusk is before dawn in minutes (crossed midnight), adjust dusk
  if (duskMinutes < dawnMinutes) {
    duskMinutes += 24 * 60; // Add 24 hours worth of minutes
  }
  
  // Log current solar schedule for debugging
  const dawnTime = `${Math.floor(dawnMinutes/60)%24}:${String(dawnMinutes%60).padStart(2, '0')}`;
  const duskTime = `${Math.floor(duskMinutes/60)%24}:${String(duskMinutes%60).padStart(2, '0')} ${duskMinutes > 24*60 ? '(+1d)' : ''}`;
  
  // Helper to format local time
  const formatLocalTime = (date: Date): string => {
    const localDate = new Date(date.getTime() + localOffset);
    const h = localDate.getUTCHours();
    const m = localDate.getUTCMinutes();
    return `${h}:${String(m).padStart(2, '0')}`;
  };
  
  // Check if we're in one of the polling windows
  
  // 1. Every 30 mins from 30 mins after dawn to 30 mins after dusk
  const activeStart = dawnMinutes + 30;  // Start 30 mins after dawn
  const activeEnd = duskMinutes + 30;    // End 30 mins after dusk
  
  if (localTimeMinutes >= activeStart && localTimeMinutes <= activeEnd) {
    // During active hours, poll on :00 and :30
    if (localMinutes === 0 || localMinutes === 30) {
      console.log(`[ENPHASE] Polling during active solar hours (dawn ${dawnTime}, dusk ${duskTime})`);
      return { shouldPollNow: true };
    }
    // Not on a polling minute during active hours - calculate next poll time
    const nextMinute = localMinutes < 30 ? 30 : 60; // Next :30 or :00
    const minutesToNext = nextMinute - localMinutes;
    const nextPollDate = new Date(currentTime.getTime() + minutesToNext * 60 * 1000);
    const nextPollTimeStr = formatLocalTime(nextPollDate);
    
    console.log(`[ENPHASE] Skipping - active hours but not at :00 or :30 (current :${String(localMinutes).padStart(2, '0')})`);
    return {
      shouldPollNow: false,
      skipReason: `Outside polling schedule (next poll in ${minutesToNext} minutes at ${nextPollTimeStr})`,
      nextPollTimeStr
    };
  }
  
  // 2. Hourly polls between 01:00-05:00 to check yesterday's data completeness
  // Poll on the hour (:00) during these hours
  if (localHour >= 1 && localHour <= 5) {
    if (localMinutes === 0) {
      console.log(`[ENPHASE] ${localHour}:00 check for yesterday's data completeness`);
      return { shouldPollNow: true };
    }
    // Calculate next hour
    const minutesToNextHour = 60 - localMinutes;
    const nextPollDate = new Date(currentTime.getTime() + minutesToNextHour * 60 * 1000);
    const nextPollTimeStr = formatLocalTime(nextPollDate);
    
    return {
      shouldPollNow: false,
      skipReason: `Outside polling schedule (next poll at ${nextPollTimeStr})`,
      nextPollTimeStr
    };
  }
  
  // 3. Outside active hours - calculate next poll time
  let nextPollMinutes: number;
  let skipReason: string;
  
  if (localTimeMinutes < activeStart) {
    // Before dawn - next poll is at dawn + 30min
    nextPollMinutes = activeStart;
    const minutesUntilNext = activeStart - localTimeMinutes;
    const hoursUntil = Math.floor(minutesUntilNext / 60);
    const minsUntil = minutesUntilNext % 60;
    if (hoursUntil > 0) {
      skipReason = `Outside polling schedule (next poll at dawn+30min in ${hoursUntil}h ${minsUntil}m)`;
    } else {
      skipReason = `Outside polling schedule (next poll at dawn+30min in ${minsUntil}m)`;
    }
    console.log(`[ENPHASE] Skipping - ${minutesUntilNext} minutes before sunrise+30min (dawn at ${dawnTime})`);
  } else {
    // After dusk - next poll is tomorrow at 01:00 or dawn+30min, whichever is earlier
    const tomorrow1AM = 25 * 60; // 01:00 tomorrow in minutes from midnight today
    const tomorrowDawn = activeStart + 24 * 60; // Tomorrow's dawn+30min
    nextPollMinutes = Math.min(tomorrow1AM, tomorrowDawn);
    
    const minutesUntilNext = nextPollMinutes - localTimeMinutes;
    const hoursUntil = Math.floor(minutesUntilNext / 60);
    const minsUntil = minutesUntilNext % 60;
    if (hoursUntil > 0) {
      skipReason = `Outside polling schedule (next poll in ${hoursUntil}h ${minsUntil}m)`;
    } else {
      skipReason = `Outside polling schedule (next poll in ${minsUntil}m)`;
    }
    console.log(`[ENPHASE] Skipping - ${localTimeMinutes - activeEnd} minutes after sunset+30min (dusk at ${duskTime})`);
  }
  
  // Calculate the actual next poll date/time
  const minutesUntilNext = nextPollMinutes - localTimeMinutes;
  const nextPollDate = new Date(currentTime.getTime() + minutesUntilNext * 60 * 1000);
  const nextPollTimeStr = formatLocalTime(nextPollDate);
  
  return {
    shouldPollNow: false,
    skipReason,
    nextPollTimeStr
  };
}

// Backward compatibility wrapper
export function shouldPollEnphaseNow(
  system: EnphaseSystemWithOwner,
  lastPollTime: Date | null,
  currentTime: Date = new Date()
): boolean {
  return checkEnphasePollingSchedule(system, lastPollTime, currentTime).shouldPollNow;
}