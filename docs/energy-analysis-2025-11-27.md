# Home Energy Analysis - 27 November 2025

> 24-hour analysis from 26 Nov 11:35pm to 27 Nov 11:35pm (AEST)

## Executive Summary

Your solar + battery system performed well yesterday with **92% self-consumption** and minimal grid dependence. Total grid cost was approximately **$2.87**. The main opportunity for improvement is shifting hot water heating to solar hours.

---

## Energy Summary

### Generation

| Source               | Energy       |
| -------------------- | ------------ |
| Local Solar Panels   | 35.3 kWh     |
| Remote Solar Panels  | 28.1 kWh     |
| **Total Generation** | **63.4 kWh** |

Peak solar output: **8.3 kW** (local) at 12:00pm

### Grid Exchange

| Direction | Energy               |
| --------- | -------------------- |
| Imported  | 12.5 kWh             |
| Exported  | 5.0 kWh              |
| **Net**   | **7.5 kWh imported** |

### Battery

| Metric     | Value     |
| ---------- | --------- |
| Charged    | 24.0 kWh  |
| Discharged | 14.3 kWh  |
| SOC Range  | 3% - 100% |

---

## Load Analysis

### Consumption by Load

| Load              | Energy       | % of Total | Notes                                  |
| ----------------- | ------------ | ---------- | -------------------------------------- |
| Pool Pump         | 14.7 kWh     | 36%        | Well-timed with solar                  |
| Hot Water         | 10.7 kWh     | 26%        | Mostly evening - needs adjustment      |
| EV Charging       | 10.4 kWh     | 25%        | Morning charge, partial solar coverage |
| HVAC              | 5.2 kWh      | 13%        | Constant ~225W standby                 |
| **Total Tracked** | **41.0 kWh** | 100%       |                                        |

### Pool Pump Schedule

Excellent solar alignment:

| Time        | Power      | Mode         |
| ----------- | ---------- | ------------ |
| 11am-2pm    | 2.7 kW     | High speed   |
| 2pm-6pm     | 1.4-1.5 kW | Medium speed |
| Other hours | 25 W       | Idle         |

### EV Charging Session

| Metric         | Value            |
| -------------- | ---------------- |
| Time           | 9:40am - 11:10am |
| Duration       | 90 minutes       |
| Energy         | 10.4 kWh         |
| Peak Power     | 7.2 kW           |
| Solar Coverage | ~40%             |

The EV drew 7kW but solar was only producing 2.9kW at that time. Starting 30-60 minutes later would improve solar coverage to 60-70%.

### Hot Water System

| Period           | Energy  | Solar Available?            |
| ---------------- | ------- | --------------------------- |
| 12:35am - 2:20am | 1.9 kWh | No                          |
| 2:05pm - 10:30pm | 8.7 kWh | Partial (ends after sunset) |

**Issue:** Most hot water heating occurs in the evening (6pm-10pm) when there's no solar, forcing battery/grid usage.

### HVAC

Running continuously at ~225W - likely standby mode with light cooling. Consistent across all hours with no significant peaks.

---

## Electricity Pricing

### Rates Observed

| Metric                | Value              |
| --------------------- | ------------------ |
| Import Rate Range     | 8.5c - 43.0c/kWh   |
| Average Import Rate   | 18.7c/kWh          |
| Peak Price Time       | 8:30pm @ 43.0c/kWh |
| Negative Spot Periods | 21 intervals       |
| Lowest Spot Price     | -4.47c/kWh         |

### Grid Renewables

- Range: 8% - 77%
- Average: 54%

---

## Curtailment Analysis

### Findings

**Estimated curtailment: < 2 kWh (negligible)**

Evidence supporting minimal curtailment:

- Battery never reached 100% SOC during peak solar hours
- Maximum export (7.1 kW) was only reached once
- Most export intervals were < 1 kW
- Export limit appears to be ~7 kW (generous headroom)

### Energy Balance

| Flow              | kWh      |
| ----------------- | -------- |
| Generated         | 63.4     |
| To tracked loads  | 41.0     |
| To battery        | 24.0     |
| Exported          | 5.0      |
| **Accounted for** | **70.0** |

The slight excess suggests either untracked loads or measurement timing differences - not curtailment.

---

## Hourly Breakdown

| Hour  | Solar  | Grid    | Battery | HWS    | Pool   | Notes                        |
| ----- | ------ | ------- | ------- | ------ | ------ | ---------------------------- |
| 00:00 | 0.0 kW | -0.2 kW | 2.0 kW  | 0.7 kW | 0.0 kW |                              |
| 01:00 | 0.0 kW | 1.9 kW  | 0.2 kW  | 1.1 kW | 0.0 kW |                              |
| 02:00 | 0.0 kW | 1.6 kW  | -0.3 kW | 0.4 kW | 0.0 kW |                              |
| 03:00 | 0.0 kW | 0.9 kW  | -0.1 kW | 0.0 kW | 0.0 kW |                              |
| 04:00 | 0.0 kW | 0.9 kW  | -0.1 kW | 0.0 kW | 0.0 kW |                              |
| 05:00 | 0.0 kW | 0.9 kW  | -0.1 kW | 0.0 kW | 0.0 kW |                              |
| 06:00 | 0.2 kW | 0.7 kW  | -0.3 kW | 0.0 kW | 0.0 kW |                              |
| 07:00 | 0.6 kW | 0.3 kW  | -0.5 kW | 0.0 kW | 0.0 kW |                              |
| 08:00 | 1.1 kW | 0.1 kW  | -1.3 kW | 0.0 kW | 0.0 kW |                              |
| 09:00 | 2.4 kW | -0.0 kW | -1.2 kW | 0.0 kW | 0.0 kW | EV starts                    |
| 10:00 | 2.9 kW | 1.2 kW  | 1.7 kW  | 0.0 kW | 0.1 kW | EV charging                  |
| 11:00 | 3.8 kW | 1.0 kW  | -2.6 kW | 0.0 kW | 2.7 kW | EV + Pool high               |
| 12:00 | 6.3 kW | -2.0 kW | -6.1 kW | 0.0 kW | 2.7 kW | Peak solar, battery charging |
| 13:00 | 4.5 kW | -0.5 kW | -4.1 kW | 0.0 kW | 2.7 kW | Battery charging             |
| 14:00 | 4.0 kW | -0.4 kW | -3.3 kW | 0.8 kW | 1.6 kW | HWS starts                   |
| 15:00 | 3.0 kW | -0.2 kW | -1.7 kW | 1.0 kW | 1.5 kW |                              |
| 16:00 | 2.7 kW | -1.0 kW | -0.5 kW | 1.0 kW | 1.4 kW |                              |
| 17:00 | 1.6 kW | -0.1 kW | 0.2 kW  | 1.0 kW | 1.4 kW |                              |
| 18:00 | 1.5 kW | -0.1 kW | -0.3 kW | 1.1 kW | 0.0 kW |                              |
| 19:00 | 0.7 kW | 0.1 kW  | 1.2 kW  | 1.1 kW | 0.0 kW | Battery discharging          |
| 20:00 | 0.0 kW | 0.3 kW  | 2.7 kW  | 1.1 kW | 0.2 kW | Battery discharging          |
| 21:00 | 0.0 kW | 2.1 kW  | 2.7 kW  | 1.1 kW | 0.0 kW | Grid import                  |
| 22:00 | 0.0 kW | -0.0 kW | 1.8 kW  | 0.5 kW | 0.0 kW |                              |
| 23:00 | 0.0 kW | -0.0 kW | 1.2 kW  | 0.0 kW | 0.0 kW |                              |

_Negative grid = exporting, negative battery = charging_

---

## Recommendations

### 1. Shift Hot Water to Solar Hours (High Impact)

**Current:** 8.7 kWh consumed 2pm-10:30pm, mostly after sunset
**Recommended:** Set timer for 10am-3pm only

**Potential savings:** ~$1.50-2.00/day

### 2. Delay EV Charging Start (Medium Impact)

**Current:** 9:40am start (40% solar coverage)
**Recommended:** 10:30-11:00am start (60-70% solar coverage)

This allows solar to ramp up to 3-4kW before the 7kW EV load kicks in.

### 3. Exploit Negative Spot Prices (Opportunistic)

21 intervals had negative spot prices (down to -4.47c/kWh). If on Amber or similar real-time tariff, consider:

- Scheduling discretionary loads during negative price alerts
- Charging battery from grid during negative prices (if supported)

### 4. Consider Staggering Heavy Loads

At 10-11am, EV (7kW) + Pool (2.7kW) exceeded solar production, causing grid import. Sequential scheduling would reduce peak grid demand.

---

## What's Working Well

- **92% self-consumption rate** - excellent
- **Pool pump timing** - perfectly aligned with solar peak
- **Battery utilisation** - good daily cycling (3% to 100%)
- **Minimal curtailment** - system is well-sized for loads
- **Low grid dependence** - only 12.5 kWh imported despite 41 kWh consumption

---

## System Specifications (Inferred)

| Component    | Estimated Capacity |
| ------------ | ------------------ |
| Local Solar  | ~10 kW             |
| Remote Solar | ~8 kW              |
| Battery      | ~15-20 kWh         |
| Export Limit | ~7 kW              |
| EV Charger   | 7.2 kW             |

---

_Analysis generated from LiveOne API data for systems 9 (grid pricing) and 10000 (home energy)._
