package gousher

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Discovery is optional inspector detail. Its requests are bounded and run outside
// the two-second power sampling loop. Replacement waits for these requests too.
func (f *Fronius) startDiscovery() {
	f.discoveryOnce.Do(func() {
		ctx, cancel := context.WithCancel(context.Background())
		f.discoveryCancel = cancel
		for _, inverter := range f.inv {
			host := inverter.Config.Host
			f.discoveryWorkers.Add(1)
			go func() {
				defer f.discoveryWorkers.Done()
				info := map[string]any{}
				if raw := f.discover(ctx, host, "GetInverterInfo.cgi"); raw != nil {
					info["inverter"] = inverterInfo(raw)
				}
				if raw := f.discover(ctx, host, "GetStorageRealtimeData.cgi"); raw != nil {
					info["battery"] = batteryInfo(raw)
				}
				if raw := f.discover(ctx, host, "GetMeterRealtimeData.cgi?Scope=System"); raw != nil {
					info["meter"] = meterInfo(raw)
				}
				f.discoveryMu.Lock()
				if f.discovery == nil {
					f.discovery = map[string]map[string]any{}
				}
				f.discovery[host] = info
				f.discoveryMu.Unlock()
			}()
		}
	})
}
func (f *Fronius) discover(parent context.Context, host, path string) map[string]any {
	ctx, cancel := context.WithTimeout(parent, 2*time.Second)
	defer cancel()
	req, e := http.NewRequestWithContext(ctx, "GET", "http://"+host+"/solar_api/v1/"+path, nil)
	if e != nil {
		return nil
	}
	res, e := f.client.Do(req)
	if e != nil {
		return nil
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return nil
	}
	data, e := readLimited(res.Body, 1<<20)
	if e != nil {
		return nil
	}
	var raw map[string]any
	if json.Unmarshal(data, &raw) != nil {
		return nil
	}
	return obj(obj(raw["Body"])["Data"])
}
func firstObject(raw map[string]any) map[string]any {
	keys := make([]string, 0, len(raw))
	for key := range raw {
		keys = append(keys, key)
	}
	sort.Slice(keys, func(i, j int) bool {
		a, ae := strconv.ParseUint(keys[i], 10, 32)
		b, be := strconv.ParseUint(keys[j], 10, 32)
		ai := ae == nil && a < 4294967295 && strconv.FormatUint(a, 10) == keys[i]
		bi := be == nil && b < 4294967295 && strconv.FormatUint(b, 10) == keys[j]
		if ai && bi {
			return a < b
		}
		if ai != bi {
			return ai
		}
		return keys[i] < keys[j]
	})
	if len(keys) == 0 {
		return nil
	}
	return obj(raw[keys[0]])
}
func inverterInfo(raw map[string]any) map[string]any {
	data := firstObject(raw)
	if data == nil {
		return nil
	}
	model := data["Type"]
	if data["DT"] == float64(1) {
		model = "Gen24"
	}
	if model == nil || model == "" {
		model = fmt.Sprintf("Unknown (DT: %v)", data["DT"])
	}
	power := data["PVPower"]
	if power == nil {
		power = float64(0)
	}
	return map[string]any{"manufacturer": "Fronius", "model": model, "pvPowerW": power, "customName": data["CustomName"], "serialNumber": data["UniqueID"]}
}
func batteryInfo(raw map[string]any) map[string]any {
	controller := obj(obj(raw["0"])["Controller"])
	if controller == nil {
		if list, ok := raw["Controller"].([]any); ok && len(list) > 0 {
			controller = obj(list[0])
		}
	}
	if controller == nil {
		return nil
	}
	details := obj(controller["Details"])
	serial, _ := details["Serial"].(string)
	return map[string]any{"manufacturer": details["Manufacturer"], "model": details["Model"], "serial": strings.TrimSpace(serial), "capacityWh": controller["Capacity_Maximum"], "enabled": controller["Enable"] == float64(1)}
}
func meterInfo(raw map[string]any) map[string]any {
	meter := firstObject(raw)
	if meter == nil {
		return nil
	}
	details := obj(meter["Details"])
	manufacturer, _ := details["Manufacturer"].(string)
	model, _ := details["Model"].(string)
	if model == "" {
		model, _ = details["Type"].(string)
	}
	if manufacturer == "" {
		manufacturer = "Unknown"
	}
	if model == "" {
		model = "Unknown"
	}
	if strings.HasPrefix(model, "CCS") {
		manufacturer = "Continental Control Systems"
	}
	serial, _ := details["Serial"].(string)
	location := "Unknown"
	n, ok := number(meter["Meter_Location_Current"])
	if ok {
		switch {
		case n == 0:
			location = "Grid (feed-in point)"
		case n == 1:
			location = "Load (consumption)"
		case n == 3:
			location = "External generator"
		case n >= 256 && n <= 511:
			location = fmt.Sprintf("Subload #%g", n-255)
		case n >= 512 && n <= 768:
			location = fmt.Sprintf("EV Charger #%g", n-511)
		case n >= 769 && n <= 1023:
			location = fmt.Sprintf("Storage #%g", n-768)
		}
	}
	return map[string]any{"manufacturer": manufacturer, "model": model, "serial": strings.TrimSpace(serial), "location": location, "enabled": meter["Enable"] == float64(1) || meter["Enabled"] == float64(1)}
}
