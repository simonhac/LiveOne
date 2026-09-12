package gousher

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestFroniusDiscoveryDoesNotDelayPowerAndPopulatesInspector(t *testing.T) {
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.Contains(r.URL.Path, "GetPowerFlow"):
			_, _ = w.Write([]byte(`{"Body":{"Data":{"Site":{"P_PV":120,"P_Grid":0,"P_Akku":0}}}}`))
		case strings.Contains(r.URL.Path, "GetInverterInfo"):
			<-release
			_, _ = w.Write([]byte(`{"Body":{"Data":{"1":{"DT":1,"UniqueID":"serial-123","CustomName":"Roof","PVPower":6000}}}}`))
		case strings.Contains(r.URL.Path, "GetStorage"):
			_, _ = w.Write([]byte(`{"Body":{"Data":{"0":{"Controller":{"Details":{"Manufacturer":"BYD","Model":"HVM","Serial":" battery-123 "},"Capacity_Maximum":11000,"Enable":1}}}}}`))
		case strings.Contains(r.URL.Path, "GetMeter"):
			_, _ = w.Write([]byte(`{"Body":{"Data":{"0":{"Details":{"Model":"CCS WattNode","Serial":" meter-123 "},"Meter_Location_Current":0,"Enabled":1}}}}`))
		}
	}))
	defer server.Close()
	f := NewFronius(Poller{Settings: Settings{Inverters: []Inverter{{Host: strings.TrimPrefix(server.URL, "http://"), Master: true, Battery: true}}}})
	defer f.Close()
	started := time.Now()
	sample, e := f.Sample(context.Background(), started)
	close(release)
	if e != nil || sample.Values["solarW"] != float64(120) {
		t.Fatal(sample, e)
	}
	if time.Since(started) > time.Second {
		t.Fatal("discovery blocked power sampling")
	}
	deadline := time.Now().Add(time.Second)
	for {
		devices := obj(f.Inspector(started)["site"])["devices"].([]map[string]any)
		if devices[0]["serialNumber"] == "serial-123" {
			device := devices[0]
			info := obj(device["info"])
			if device["name"] != "Roof" || obj(info["inverter"])["model"] != "Gen24" || obj(info["battery"])["serial"] != "battery-123" || obj(info["meter"])["manufacturer"] != "Continental Control Systems" {
				t.Fatal(device)
			}
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("inspector never received discovered device identity")
		}
		time.Sleep(time.Millisecond)
	}
}

func TestFroniusDiscoveryUsesJavaScriptNumericDeviceOrder(t *testing.T) {
	info := inverterInfo(map[string]any{"10": map[string]any{"UniqueID": "second"}, "2": map[string]any{"UniqueID": "first"}})
	if info["serialNumber"] != "first" {
		t.Fatal("device order differs from TypeScript Object.values", info)
	}
}
func TestFroniusCloseCancelsOutstandingDiscovery(t *testing.T) {
	entered := make(chan struct{}, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "GetPowerFlow") {
			_, _ = w.Write([]byte(`{"Body":{"Data":{"Site":{"P_PV":100}}}}`))
			return
		}
		select {
		case entered <- struct{}{}:
		default:
		}
		<-r.Context().Done()
	}))
	defer server.Close()
	f := NewFronius(Poller{Settings: Settings{Inverters: []Inverter{{Host: strings.TrimPrefix(server.URL, "http://"), Master: true}}}})
	if _, e := f.Sample(context.Background(), time.Now()); e != nil {
		f.Close()
		t.Fatal(e)
	}
	select {
	case <-entered:
	case <-time.After(time.Second):
		f.Close()
		t.Fatal("discovery did not start")
	}
	started := time.Now()
	if e := f.Close(); e != nil {
		t.Fatal(e)
	}
	if time.Since(started) > time.Second {
		t.Fatal("discovery delayed reader replacement")
	}
}

func TestFroniusPowerUsesJavaScriptNumericDeviceOrder(t *testing.T) {
	f := NewFronius(Poller{Settings: Settings{Inverters: []Inverter{{Host: "master", Master: true}}}})
	defer f.Close()
	raw := map[string]any{"Body": map[string]any{"Data": map[string]any{"Site": map[string]any{"P_PV": 1.0}, "Inverters": map[string]any{"10": map[string]any{"SOC": 10.0}, "2": map[string]any{"SOC": 20.0}}}}}
	if e := f.inv[0].ingest(raw, time.Now()); e != nil {
		t.Fatal(e)
	}
	if f.inv[0].Last["batterySOC"] != float64(20) {
		t.Fatal("power parser chose a different inverter than TypeScript", f.inv[0].Last)
	}
}

func TestFroniusCollectionStopCancelsDiscovery(t *testing.T) {
	entered := make(chan struct{}, 1)
	stopped := make(chan struct{}, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "GetPowerFlow") {
			_, _ = w.Write([]byte(`{"Body":{"Data":{"Site":{"P_PV":100}}}}`))
			return
		}
		select {
		case entered <- struct{}{}:
		default:
		}
		<-r.Context().Done()
		select {
		case stopped <- struct{}{}:
		default:
		}
	}))
	defer server.Close()
	f := NewFronius(Poller{Settings: Settings{Inverters: []Inverter{{Host: strings.TrimPrefix(server.URL, "http://"), Master: true}}}})
	defer f.Close()
	r := testRuntime(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	g := &generation{p: Poller{ID: "p", Source: "fronius", Settings: Settings{PollMS: 2000, PushMS: 60000}}, source: f, done: make(chan struct{})}
	go r.collect(ctx, g)
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("no discovery request")
	}
	cancel()
	<-g.done
	select {
	case <-stopped:
	case <-time.After(200 * time.Millisecond):
		t.Fatal("reader stopped but discovery was still querying the device")
	}
}
