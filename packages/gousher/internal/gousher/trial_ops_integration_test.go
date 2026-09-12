package gousher

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func opsTestConfig(t *testing.T, receiver, inspector, production string, from time.Time) TrialOpsConfig {
	t.Helper()
	t.Setenv("OPS_TEST_PRODUCTION", "production-secret")
	t.Setenv("OPS_TEST_RECEIVER", "receiver-secret")
	t.Setenv("OPS_TEST_INSPECTOR", "inspector-secret")
	return TrialOpsConfig{DataDir: t.TempDir(), ReceiverURL: receiver + "/export", ReceiverTokenEnv: "OPS_TEST_RECEIVER", InspectorURL: inspector, InspectorTokenEnv: "OPS_TEST_INSPECTOR", Pollers: []TrialOpsPoller{{ID: "p", Revision: 1, Source: "selectronic", VendorSiteID: "site", ProductionSiteID: "site", From: from, BaselineEnd: from.Add(-15 * time.Minute), Baseline: ProductionMetrics{WindowMetrics: WindowMetrics{FailureRate: 0, P95ReadMS: 100}, Samples: 15}, ReferenceURL: production + "/reference", ReferenceTokenEnv: "OPS_TEST_PRODUCTION", MetricsURL: production + "/metrics", MetricsTokenEnv: "OPS_TEST_PRODUCTION"}}}
}
func TestOperationsMonitorTripsRealRuntimeAndPersistsShutdown(t *testing.T) {
	runtime := testRuntime(t)
	runtime.inspectorToken = "inspector-secret"
	runtime.cached.Config.Pollers = []Poller{{ID: "p", Revision: 1}}
	readCtx, cancel := context.WithCancel(context.Background())
	defer cancel()
	runtime.readerCancels = map[string]readerCancellation{"p": {revision: 1, cancel: cancel}}
	inspector := httptest.NewServer(runtime.Handler())
	defer inspector.Close()
	from := time.Now().UTC().Truncate(time.Hour).Add(-time.Hour)
	production := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !authorized(r, "production-secret") {
			w.WriteHeader(401)
			return
		}
		if r.URL.Query().Get("kind") == "incidents" {
			jsonResponse(w, 200, map[string]any{"role": "production", "siteId": "site", "incidents": []any{}})
		} else {
			jsonResponse(w, 200, map[string]any{"role": "production", "siteId": "site", "windowEnd": r.URL.Query().Get("end"), "metrics": ProductionMetrics{WindowMetrics: WindowMetrics{FailureRate: .1, P95ReadMS: 300}, Samples: 15}})
		}
	}))
	defer production.Close()
	cfg := opsTestConfig(t, production.URL, inspector.URL, production.URL, from)
	ops, err := NewTrialOps(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if err := ops.MonitorOnce(context.Background(), from.Add(15*time.Minute)); err != nil {
		t.Fatal(err)
	}
	if readCtx.Err() != nil {
		t.Fatal("one bad window stopped reader")
	}
	if err := ops.MonitorOnce(context.Background(), from.Add(30*time.Minute)); err != nil {
		t.Fatal(err)
	}
	if readCtx.Err() == nil {
		t.Fatal("two bad windows did not stop reader")
	}
	runtime.trial = nil
	if err := runtime.loadTrialState(); err != nil {
		t.Fatal(err)
	}
	if !runtime.trial["p"].Disabled {
		t.Fatal("shutdown not durable")
	}
	if err := ops.MonitorOnce(context.Background(), from.Add(30*time.Minute)); err != nil {
		t.Fatal(err)
	}
}
func TestDailyOperationsUsesRealReceiverExportAndReportsCompleteDay(t *testing.T) {
	day := time.Now().UTC().Truncate(24 * time.Hour).Add(-24 * time.Hour)
	h, err := Receiver(t.TempDir(), "receiver-secret", 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	receiver := httptest.NewServer(h)
	defer receiver.Close()
	for hour := 0; hour < 24; hour++ {
		b := Batch{ID: fmt.Sprintf("%032x", hour+1), PollerID: "p", Revision: 1, VendorSiteID: "site", MeasurementTime: day.Add(time.Duration(hour)*time.Hour + time.Minute), Readings: []Reading{{"physicalPathTail": "power", "value": 42}}}
		data, _ := json.Marshal(b)
		req := httptest.NewRequest("POST", "/", bytes.NewReader(data))
		req.Header.Set("Authorization", "Bearer receiver-secret")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req)
		if w.Code != 200 {
			t.Fatal(w.Code)
		}
	}
	production := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !authorized(r, "production-secret") {
			w.WriteHeader(401)
			return
		}
		start, _ := time.Parse(time.RFC3339Nano, r.URL.Query().Get("start"))
		jsonResponse(w, 200, map[string]any{"fixtures": []Fixture{{Source: "selectronic", PollerID: "p", Revision: 1, At: start.Add(time.Minute), Harvest: true, Expected: []Reading{{"physicalPathTail": "power", "value": 42}}}}})
	}))
	defer production.Close()
	cfg := opsTestConfig(t, receiver.URL, production.URL, production.URL, day)
	ops, err := NewTrialOps(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if err := ops.DailyOnce(context.Background(), day.Add(26*time.Hour)); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(filepath.Join(cfg.DataDir, "summaries"))
	if err != nil || len(entries) != 1 {
		t.Fatal(entries, err)
	}
	data, _ := os.ReadFile(filepath.Join(cfg.DataDir, "summaries", entries[0].Name()))
	var summary struct {
		Clean      bool
		Comparison ComparisonReport
	}
	json.Unmarshal(data, &summary)
	if !summary.Clean || summary.Comparison.Matched != 24 {
		t.Fatal(string(data))
	}
	if err := ops.DailyOnce(context.Background(), day.Add(26*time.Hour)); err != nil {
		t.Fatal(err)
	}
	entries, _ = os.ReadDir(filepath.Join(cfg.DataDir, "summaries"))
	if len(entries) != 1 {
		t.Fatal("checkpoint lost")
	}
}
