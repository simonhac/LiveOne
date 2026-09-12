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

func TestDailySchedulerPersistsReviewAndRetriesFailedExports(t *testing.T) {
	day := time.Date(2026, 9, 10, 0, 0, 0, 0, time.UTC)
	fetches := 0
	fail := true
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fetches++
		if fail {
			w.WriteHeader(503)
			return
		}
		if r.URL.Path == "/export" {
			jsonResponse(w, 200, map[string]any{"batches": []Batch{}})
		} else {
			jsonResponse(w, 200, map[string]any{"fixtures": []Fixture{}})
		}
	}))
	defer server.Close()
	p := TrialOpsPoller{ID: "p", Revision: 1, Source: "selectronic", VendorSiteID: "site", ProductionSiteID: "site", From: day, ReferenceURL: server.URL + "/reference", ReferenceTokenEnv: "REF"}
	ops := &TrialOps{cfg: TrialOpsConfig{DataDir: t.TempDir(), ReceiverURL: server.URL + "/export", ReceiverTokenEnv: "REF", Pollers: []TrialOpsPoller{p}}, client: server.Client()}
	t.Setenv("REF", "secret")
	now := day.Add(26 * time.Hour)
	if err := ops.DailyOnce(context.Background(), now); err == nil {
		t.Fatal("failed export considered complete")
	}
	fail = false
	if err := ops.DailyOnce(context.Background(), now); err == nil {
		t.Fatal("empty day marked clean")
	}
	before := fetches
	if err := ops.DailyOnce(context.Background(), now); err == nil {
		t.Fatal("unreviewed day vanished from health")
	}
	if fetches != before {
		t.Fatal("completed nonclean day re-exported")
	}
	data, err := os.ReadFile(filepath.Join(ops.cfg.DataDir, "daily-state.json"))
	if err != nil {
		t.Fatal(err)
	}
	var state map[string]any
	if json.Unmarshal(data, &state) != nil || len(state) != 1 {
		t.Fatal(string(data))
	}
}

func TestComparisonEvidenceIncludesMissingAndExtraSamples(t *testing.T) {
	at := time.Now()
	ref := []Batch{{VendorSiteID: "site", MeasurementTime: at, Readings: []Reading{{"physicalPathTail": "p", "value": 1}}}, {VendorSiteID: "site", MeasurementTime: at.Add(time.Hour)}}
	actual := []Batch{{VendorSiteID: "site", MeasurementTime: at, Readings: []Reading{{"physicalPathTail": "p", "value": 2}}}, {VendorSiteID: "other", MeasurementTime: at}}
	report, evidence := CompareWithEvidence(ref, actual, time.Second, 10)
	if report.Mismatches != 1 || report.UnmatchedReference != 1 || report.UnmatchedActual != 1 || len(evidence) != 3 {
		t.Fatal(report, evidence)
	}
}

func TestOperationsHealthRejectsStaleOrMissingChecks(t *testing.T) {
	ops := &TrialOps{cfg: TrialOpsConfig{DataDir: t.TempDir()}}
	if err := CheckTrialOpsHealth(ops.cfg.DataDir, time.Now()); err == nil {
		t.Fatal("missing health accepted")
	}
	if err := ops.health("monitor", nil); err != nil {
		t.Fatal(err)
	}
	if err := ops.health("comparison", nil); err != nil {
		t.Fatal(err)
	}
	if err := CheckTrialOpsHealth(ops.cfg.DataDir, time.Now()); err != nil {
		t.Fatal(err)
	}
	if err := CheckTrialOpsHealth(ops.cfg.DataDir, time.Now().Add(3*time.Minute)); err == nil {
		t.Fatal("stale monitor healthy")
	}
}

func TestOperationsRejectsNullCheckpoint(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	if err := os.WriteFile(path, []byte("null"), 0600); err != nil {
		t.Fatal(err)
	}
	state := map[string]dailyCursor{}
	if err := loadOpsState(path, &state); err == nil {
		t.Fatal("null checkpoint accepted")
	}
}
