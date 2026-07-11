#!/usr/bin/env tsx
/**
 * discover-fronius — a standalone, occasional-use SETUP helper. NOT part of the usher runtime.
 *
 * ARP-scans the LOCAL network to find Fronius inverters and prints a `usher.yaml` fronius-source
 * snippet you can paste in. Run it ON the site LAN (e.g. from a laptop or the Pi) during setup — it
 * is deliberately NOT wired into the collector: over the WireGuard tunnel there is no broadcast LAN
 * to ARP-scan, so the usher addresses inverters by explicit host instead. (This is the "ARP stuff"
 * extracted out of FroniusPusher.)
 *
 *   npm run -w @liveone/usher discover:fronius
 */
import axios from "axios";
import { exec } from "child_process";
import { promisify } from "util";
import * as os from "os";

const execAsync = promisify(exec);

interface NetworkInterface {
  address: string;
  netmask: string;
  family: string;
  internal: boolean;
}

interface FroniusDevice {
  ip: string;
  mac: string;
  hostname?: string;
  isMaster: boolean;
  serialNumber: string; // Required unique identifier
  data?: any;
  info?: {
    CustomName?: string;
    DT?: number;
    StatusCode?: number;
    manufacturer?: string;
    model?: string;
  };
}

function getLocalNetworks(): string[] {
  const interfaces = os.networkInterfaces();
  const networks: string[] = [];

  for (const [name, ifaces] of Object.entries(interfaces)) {
    if (ifaces) {
      for (const iface of ifaces) {
        if (iface.family === "IPv4" && !iface.internal) {
          const subnet = calculateSubnet(iface.address, iface.netmask);
          if (subnet) networks.push(subnet);
        }
      }
    }
  }

  return networks;
}

function calculateSubnet(ip: string, netmask: string): string | null {
  const ipParts = ip.split(".").map(Number);
  const maskParts = netmask.split(".").map(Number);

  const networkParts = ipParts.map((part, i) => part & maskParts[i]);
  const cidr = maskParts.reduce((acc, part) => {
    return acc + part.toString(2).replace(/0/g, "").length;
  }, 0);

  return `${networkParts.join(".")}/24`;
}

interface ArpEntry {
  mac: string;
  hostname?: string;
}

async function scanNetwork(): Promise<Map<string, ArpEntry>> {
  const arpTable = new Map<string, ArpEntry>();

  try {
    const platform = os.platform();
    let command = "";

    if (platform === "darwin") {
      command = "arp -a";
    } else if (platform === "linux") {
      command = "arp -n";
    } else if (platform === "win32") {
      command = "arp -a";
    } else {
      throw new Error(`Unsupported platform: ${platform}`);
    }

    const { stdout } = await execAsync(command);
    const lines = stdout.split("\n");

    for (const line of lines) {
      // Parse different ARP output formats
      // macOS format: hostname (IP) at MAC [ether] on interface
      // Linux format: IP ether MAC C interface

      // Try to match with hostname (macOS style)
      let match = line.match(
        /^([^\s(]+)\s+\((\d+\.\d+\.\d+\.\d+)\)\s+at\s+([0-9a-fA-F]{1,2}[:\-][0-9a-fA-F]{1,2}[:\-][0-9a-fA-F]{1,2}[:\-][0-9a-fA-F]{1,2}[:\-][0-9a-fA-F]{1,2}[:\-][0-9a-fA-F]{1,2})/i,
      );

      if (match) {
        // macOS format with hostname
        const hostname = match[1];
        const ip = match[2];
        const mac = match[3];

        // Normalise MAC to standard format (pad octets to 2 digits)
        const separator = mac.includes(":") ? ":" : "-";
        const octets = mac.split(separator);
        const normalisedMac = octets
          .map((octet) => octet.padStart(2, "0").toLowerCase())
          .join(":");

        arpTable.set(ip, {
          mac: normalisedMac,
          hostname: hostname !== "?" ? hostname : undefined,
        });
      } else {
        // Try simpler format without hostname
        match = line.match(
          /(\d+\.\d+\.\d+\.\d+).*?([0-9a-fA-F]{1,2}[:\-][0-9a-fA-F]{1,2}[:\-][0-9a-fA-F]{1,2}[:\-][0-9a-fA-F]{1,2}[:\-][0-9a-fA-F]{1,2}[:\-][0-9a-fA-F]{1,2})/i,
        );

        if (match) {
          const ip = match[1];
          const mac = match[2];

          // Normalise MAC to standard format
          const separator = mac.includes(":") ? ":" : "-";
          const octets = mac.split(separator);
          const normalisedMac = octets
            .map((octet) => octet.padStart(2, "0").toLowerCase())
            .join(":");

          arpTable.set(ip, { mac: normalisedMac });
        }
      }
    }
  } catch (error) {
    console.error("Error scanning ARP table:", error);
  }

  return arpTable;
}

async function pingSubnet(subnet: string): Promise<void> {
  const baseIP = subnet.split("/")[0];
  const parts = baseIP.split(".").map(Number);
  const promises: Promise<void>[] = [];

  for (let i = 1; i <= 254; i++) {
    const ip = `${parts[0]}.${parts[1]}.${parts[2]}.${i}`;
    const platform = os.platform();
    const pingCommand =
      platform === "win32" ? `ping -n 1 -w 100 ${ip}` : `ping -c 1 -W 1 ${ip}`;

    promises.push(
      execAsync(pingCommand)
        .then(() => {})
        .catch(() => {}),
    );
  }

  await Promise.all(promises);
}

async function checkFroniusDevice(ip: string): Promise<boolean> {
  try {
    console.log(`  Testing if ${ip} is a Fronius device...`);
    const response = await axios.get(
      `http://${ip}/solar_api/GetAPIVersion.cgi`,
      {
        timeout: 2000,
        validateStatus: (status) => status === 200,
      },
    );

    // Check if response has expected Fronius API structure
    if (response.data && typeof response.data === "object") {
      // Fronius API responses typically have APIVersion, BaseURL, or Body fields
      const hasApiVersion = "APIVersion" in response.data;
      const hasBaseUrl = "BaseURL" in response.data;
      const hasBody = "Body" in response.data;

      if (hasApiVersion || hasBaseUrl || hasBody) {
        console.log(
          `    ✓ ${ip} is a Fronius device (API version: ${response.data.APIVersion || "unknown"})`,
        );
        return true;
      } else {
        console.log(
          `    ✗ ${ip} returned 200 but not Fronius API structure. Keys found: ${Object.keys(response.data).join(", ")}`,
        );
        return false;
      }
    }
    console.log(`    ✗ ${ip} returned invalid response format`);
    return false;
  } catch (error: any) {
    if (error.code === "ECONNREFUSED" || error.code === "ETIMEDOUT") {
      // Silent fail for connection issues
    } else {
      console.log(`    ✗ ${ip} check failed: ${error.message}`);
    }
    return false;
  }
}

async function checkIfMaster(ip: string): Promise<boolean> {
  try {
    console.log(`  Checking if ${ip} is master...`);

    // A unit is master if it monitors load (P_Load in the Site data)
    try {
      const powerFlowResponse = await axios.get(
        `http://${ip}/solar_api/v1/GetPowerFlowRealtimeData.fcgi`,
        {
          timeout: 2000,
        },
      );

      if (powerFlowResponse.data?.Body?.Data?.Site) {
        const site = powerFlowResponse.data.Body.Data.Site;
        console.log(
          `    ${ip} has Site data: P_Grid=${site.P_Grid}W, P_Load=${site.P_Load}W, P_PV=${site.P_PV}W`,
        );

        // Master is determined by having P_Load data (monitoring load)
        if (site.P_Load !== undefined && site.P_Load !== null) {
          console.log(`    ✓ ${ip} is MASTER (monitors load: ${site.P_Load}W)`);
          return true;
        } else {
          console.log(`    ${ip} is SLAVE (no load monitoring)`);
          return false;
        }
      } else if (powerFlowResponse.data?.Body?.Data?.Inverters) {
        console.log(`    ${ip} has Inverters data but no Site data - SLAVE`);
        return false;
      }
    } catch (error: any) {
      console.log(
        `    Could not get power flow data from ${ip}: ${error.message}`,
      );
    }

    console.log(`    ${ip} is NOT master (no load data)`);
    return false;
  } catch (error: any) {
    console.error(`    Error checking master status for ${ip}:`, error.message);
    return false;
  }
}

async function getFroniusData(ip: string): Promise<any> {
  try {
    const response = await axios.get(
      `http://${ip}/solar_api/v1/GetPowerFlowRealtimeData.fcgi`,
      {
        timeout: 5000,
      },
    );
    return response.data;
  } catch (error) {
    console.error(`Error fetching data from ${ip}:`, error);
    return null;
  }
}

export async function discoverFroniusInverters(): Promise<FroniusDevice[]> {
  console.log("Starting Fronius inverter discovery...");

  const networks = getLocalNetworks();
  console.log("Found networks:", networks);

  for (const network of networks) {
    console.log(`Pinging subnet ${network}...`);
    await pingSubnet(network);
  }

  await new Promise((resolve) => setTimeout(resolve, 2000));

  const arpTable = await scanNetwork();
  console.log(`Found ${arpTable.size} devices in ARP table`);

  const froniusDevices: FroniusDevice[] = [];
  const checkPromises: Promise<void>[] = [];

  for (const [ip, arpEntry] of arpTable.entries()) {
    checkPromises.push(
      checkFroniusDevice(ip).then(async (isFronius) => {
        if (isFronius) {
          const hostnameInfo = arpEntry.hostname
            ? ` (${arpEntry.hostname})`
            : "";
          console.log(
            `✓ Found Fronius device at ${ip}${hostnameInfo} (MAC: ${arpEntry.mac})`,
          );

          // Fetch inverter info for display
          let info: any = {};
          let serialNumber: string | undefined;
          try {
            const infoResponse = await axios.get(
              `http://${ip}/solar_api/v1/GetInverterInfo.cgi`,
              {
                timeout: 2000,
              },
            );
            if (infoResponse.data?.Body?.Data) {
              // Get the first inverter's info (usually there's only one per device)
              const inverters = Object.values(infoResponse.data.Body.Data);
              if (inverters.length > 0) {
                const firstInverter = inverters[0] as any;
                serialNumber = firstInverter.UniqueID;
                info = {
                  CustomName: firstInverter.CustomName,
                  DT: firstInverter.DT,
                  StatusCode: firstInverter.StatusCode,
                };
                console.log(
                  `  Device info: ${info.CustomName || "No name"} (S/N: ${serialNumber || "Unknown"})`,
                );
              }
            }
          } catch (error) {
            console.log(`  Could not fetch device info for ${ip}`);
          }

          // Try to fetch manufacturer and model from components API
          try {
            const componentsResponse = await axios.get(
              `http://${ip}/api/components/inverter/readable`,
              {
                timeout: 2000,
              },
            );
            if (componentsResponse.data?.Body?.Data?.["0"]?.attributes) {
              const attrs = componentsResponse.data.Body.Data["0"].attributes;
              info.manufacturer = attrs.manufacturer || "Fronius";
              info.model = attrs.model || "Unknown Model";
              console.log(`  Device model: ${info.manufacturer} ${info.model}`);
            }
          } catch (error) {
            // This endpoint may not exist on all models, ignore error
          }

          const isMaster = await checkIfMaster(ip);

          // Ensure we always have a serial number - use the device's UniqueID or generate from MAC
          if (!serialNumber) {
            serialNumber = `UNKNOWN_${arpEntry.mac.replace(/:/g, "")}`;
            console.log(
              `  Warning: No serial number found, using generated ID: ${serialNumber}`,
            );
          }

          froniusDevices.push({
            ip,
            mac: arpEntry.mac,
            hostname: arpEntry.hostname,
            isMaster,
            serialNumber,
            info,
          });
        }
      }),
    );
  }

  await Promise.all(checkPromises);

  console.log(
    `\nDiscovery complete. Found ${froniusDevices.length} Fronius device(s):`,
  );
  froniusDevices.forEach((device) => {
    console.log(
      `  - ${device.ip} (${device.mac}) - ${device.isMaster ? "MASTER" : "SLAVE"}`,
    );
  });

  const masterDevice = froniusDevices.find((device) => device.isMaster);
  if (masterDevice) {
    console.log(
      `\nFetching data from master inverter at ${masterDevice.ip}...`,
    );
    masterDevice.data = await getFroniusData(masterDevice.ip);
    if (masterDevice.data) {
      console.log(`✓ Successfully fetched power flow data from master`);
    }
  } else {
    console.log("\n⚠ No master inverter found among discovered devices");
  }

  return froniusDevices;
}

export async function getMasterInverterData(): Promise<any> {
  const devices = await discoverFroniusInverters();
  const master = devices.find((d) => d.isMaster);

  if (!master) {
    throw new Error("No master Fronius inverter found on the network");
  }

  return master.data || (await getFroniusData(master.ip));
}

// ── CLI ───────────────────────────────────────────────────────────────────────
// Run the scan and print a usher.yaml fronius-source snippet to paste in.
async function main() {
  const devices = await discoverFroniusInverters();
  if (devices.length === 0) {
    console.log("\nNo Fronius inverters found on the local network.");
    process.exit(1);
  }
  const lines = [
    "",
    "── paste into usher.yaml under `sources:` (set siteId + apiKeyEnv) ──",
    "  - type: fronius",
    "    siteId: <your-site>",
    "    apiKeyEnv: <YOUR_SITE_API_KEY>",
    "    inverters:",
    ...devices.map(
      (d) =>
        `      - host: ${d.ip}${d.isMaster ? "   # master" : ""}` +
        (d.serialNumber ? `   # S/N ${d.serialNumber}` : ""),
    ),
  ];
  console.log(lines.join("\n"));
}

// Only run when invoked directly (never on import — this file must stay out of the runtime path).
if (process.argv[1] && process.argv[1].includes("discover-fronius")) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
