package gousher

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestTrialOpsComparesRetainsAndCheckpointsOnlyAfterAcknowledgement(t *testing.T) {
	day := time.Date(2026, 9, 10, 0, 0, 0, 0, time.UTC)
	calls := 0
	reject := true
	feed := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/reference":
			jsonResponse(w, 200, map[string]any{"fixtures": []Fixture{{Source: "selectronic", PollerID: "p", Revision: 1, At: day.Add(time.Minute), Harvest: true, Expected: []Reading{{"physicalPathTail": "power", "value": 1}}}}})
		case "/export":
			jsonResponse(w, 200, map[string]any{"batches": []Batch{{ID: "a", PollerID: "p", Revision: 1, VendorSiteID: "site", MeasurementTime: day.Add(time.Minute), Readings: []Reading{{"physicalPathTail": "power", "value": 2}}}}})
		case "/metrics":
			if r.URL.Query().Get("kind") == "incidents" {
				jsonResponse(w, 200, map[string]any{"role": "production", "siteId": "site", "incidents": []any{}})
			} else {
				jsonResponse(w, 200, map[string]any{"role": "production", "siteId": "site", "windowEnd": r.URL.Query().Get("end"), "metrics": ProductionMetrics{WindowMetrics: WindowMetrics{FailureRate: .1, P95ReadMS: 300}, Samples: 20}})
			}
		case "/api/trial/windows":
			calls++
			if reject {
				w.WriteHeader(503)
			} else {
				jsonResponse(w, 200, map[string]any{"revision": 1, "disabled": calls >= 2})
			}
		default:
			w.WriteHeader(404)
		}
	}))
	defer feed.Close()
	t.Setenv("OPS_REF", "ref")
	t.Setenv("OPS_RECEIVER", "receiver")
	t.Setenv("OPS_INSPECTOR", "inspect")
	cfg := TrialOpsConfig{DataDir: t.TempDir(), ReceiverURL: feed.URL + "/export", ReceiverTokenEnv: "OPS_RECEIVER", InspectorURL: feed.URL, InspectorTokenEnv: "OPS_INSPECTOR", Pollers: []TrialOpsPoller{{ID: "p", Revision: 1, Source: "selectronic", VendorSiteID: "site", ProductionSiteID: "site", ReferenceURL: feed.URL + "/reference", ReferenceTokenEnv: "OPS_REF", MetricsURL: feed.URL + "/metrics", MetricsTokenEnv: "OPS_REF", From: day, BaselineEnd: day.Add(-15 * time.Minute), Baseline: ProductionMetrics{WindowMetrics: WindowMetrics{FailureRate: 0, P95ReadMS: 100}, Samples: 20}}}}
	ops, err := NewTrialOps(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if err := ops.MonitorOnce(context.Background(), day.Add(15*time.Minute)); err == nil {
		t.Fatal("503 acknowledged")
	}
	reject = false
	if err := ops.MonitorOnce(context.Background(), day.Add(15*time.Minute)); err != nil {
		t.Fatal(err)
	}
	if calls != 2 {
		t.Fatal("unacknowledged window not retried")
	}
	if err := ops.MonitorOnce(context.Background(), day.Add(15*time.Minute)); err != nil {
		t.Fatal(err)
	}
	if calls != 2 {
		t.Fatal("acknowledged window sent twice")
	}
	if err := ops.CompareDay(context.Background(), cfg.Pollers[0], day); err == nil {
		t.Fatal("mismatching day certified clean")
	}
	entries, err := os.ReadDir(filepath.Join(cfg.DataDir, "fixtures"))
	if err != nil || len(entries) == 0 {
		t.Fatal("discrepancy evidence missing", err)
	}
	entries, err = os.ReadDir(filepath.Join(cfg.DataDir, "summaries"))
	if err != nil || len(entries) == 0 {
		t.Fatal("daily report missing", err)
	}
	var report map[string]any
	b, _ := os.ReadFile(filepath.Join(cfg.DataDir, "summaries", entries[0].Name()))
	json.Unmarshal(b, &report)
	if report["clean"] != false {
		t.Fatal(report)
	}
}
