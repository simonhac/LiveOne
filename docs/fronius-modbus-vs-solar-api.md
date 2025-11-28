# Fronius GEN24: Modbus vs Solar API

## Current Setup (Solar API)

FroniusPusher uses the **Fronius Solar API** - HTTP/JSON endpoints on the inverter's local network:

| Endpoint                                      | Data                                    |
| --------------------------------------------- | --------------------------------------- |
| `/solar_api/v1/GetPowerFlowRealtimeData.fcgi` | Power (solar, battery, grid, load), SOC |
| `/solar_api/v1/GetStorageRealtimeData.cgi`    | Battery specs (capacity, manufacturer)  |
| `/solar_api/v1/GetInverterInfo.cgi`           | Inverter model, PV capacity             |
| `/solar_api/v1/GetMeterRealtimeData.cgi`      | Meter readings, energy counters         |

**Limitations**: Read-only, no battery control mode, no per-phase data, no per-MPPT data.

---

## What Modbus Adds

### Battery State (`ChaSt` register)

The main win - tells you exactly what the battery is doing:

| Value       | State            |
| ----------- | ---------------- |
| OFF         | Battery offline  |
| EMPTY       | Depleted         |
| DISCHARGING | Supplying load   |
| CHARGING    | Accepting charge |
| FULL        | At capacity      |
| HOLDING     | Maintaining SOC  |
| TESTING     | Diagnostic mode  |

### Battery Control Mode (`StorCtl_Mod` - register 40348)

| Value | Mode                          |
| ----- | ----------------------------- |
| 0     | Normal charge/discharge       |
| 1     | Discharge only                |
| 2     | Charge only (force charge)    |
| 3     | Limited (uses rate registers) |

Related registers:

- `MinRsvPct` (40350): Minimum reserve percentage
- `OutWRte` (40355): Discharge rate limit
- `InWRte` (40356): Charge rate limit
- `ChaGriSet`: Grid charging permission

### Per-Phase Electrical Data

Not available via Solar API:

- L1, L2, L3 voltage (phase-to-phase and phase-to-neutral)
- Per-phase current, power, power factor
- Phase-specific alarms

### Per-MPPT DC Data (Model 160)

Individual string monitoring:

- DC voltage per MPPT input
- DC current per MPPT input
- DC power per MPPT input
- Energy counters per string

### Active Control Status (`StActCtl`)

Bit field showing what's currently active:

- Power reduction active
- Reactive power control active
- Power factor control active

### Grid Protection Settings

- Voltage/frequency trip limits
- Ramp rates
- Reconnection conditions

---

## SunSpec Models Available

| Model   | Purpose                                      |
| ------- | -------------------------------------------- |
| 120     | Nameplate (device ratings)                   |
| 121     | Basic settings (power limits)                |
| 122     | Extended measurements & status               |
| 123     | Immediate control (standby, power reduction) |
| 124     | Basic storage control                        |
| 160     | Multiple MPPT extension                      |
| 701-713 | Advanced grid functions (Primo GEN24 only)   |

---

## Implementation Requirements

### Enabling Modbus on the GEN24

1. **Open inverter web UI** - Browse to the inverter's IP address (e.g., `http://192.168.1.xxx`)

2. **Navigate to**: `Communication` → `Modbus`

3. **Configure TCP Server**:

   | Setting                | Value                                           |
   | ---------------------- | ----------------------------------------------- |
   | **Modbus Port**        | 502 (default) or 1502                           |
   | **SunSpec Model Type** | "float" or "int + SF"                           |
   | **Allow Control**      | ✓ Enable (required for write operations)        |
   | **Restrict Control**   | Optional - whitelist IPs that can send commands |

4. **Save** - the inverter will start listening on port 502

**Notes:**

- **Technician password** may be required depending on firmware version
- **"Allow Control"** must be enabled to write to registers (not just read)
- **Restrict Control** is a security feature - add your FroniusPusher device's IP if enabled
- Default **Unit ID** is `1` for the inverter

### Verify Connectivity

From the machine running FroniusPusher:

```bash
nc -zv <inverter-ip> 502
```

### In FroniusPusher

Add a Modbus TCP client library, e.g.:

- `jsmodbus` (pure JS)
- `modbus-serial` (Node.js)

Example read:

```typescript
import ModbusRTU from "modbus-serial";

const client = new ModbusRTU();
await client.connectTCP(inverterIP, { port: 502 });
client.setID(1);

// Read StorCtl_Mod (register 40348)
const result = await client.readHoldingRegisters(40348 - 40001, 1);
const controlMode = result.data[0];
```

### Important Gotchas

1. **Register addresses are dynamic** - SunSpec models are chained, so absolute addresses depend on which models are enabled
2. **Must scan for model start addresses** - Search for model ID, then use offsets
3. **Some registers are 32-bit** - Span two 16-bit registers (low word first)

---

## Is It Worth It?

### Yes, if you want:

- Battery mode visibility (`ChaSt`: CHARGING vs DISCHARGING vs HOLDING)
- Per-string solar data (diagnose shading/faults)
- Per-phase grid data
- Future: inverter control (force charge, limit export)

### Probably not, if:

- Aggregate power/energy is sufficient (Solar API has this)
- Can't enable Modbus on the GEN24
- Network isolation prevents port 502 access

---

## References

- [Fronius Modbus Manual](https://manuals.fronius.com/html/4204102649/en-US.html)
- [Modbus Register PDF](https://www.fronius.com/~/downloads/Solar%20Energy/Operating%20Instructions/42,0410,2649.pdf)
- [FroniusModbusRtu GitHub](https://github.com/otti/FroniusModbusRtu)
- [fronius-modbus-controller](https://github.com/jtbnz/fronius-modbus-controller)
