package gousher

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// These expectations follow packages/usher/core/control.ts. All writes hit a simulator.
func TestFailedEarlyReleaseRetriesBeforeDeadlineAndAfterRestart(t *testing.T) {
	for _, armed := range []bool{false, true} {
		t.Run(map[bool]string{false: "idle", true: "armed"}[armed], func(t *testing.T) {
			target := &simulator{}
			path := filepath.Join(t.TempDir(), "run.json")
			s, err := OpenSupervisor(target, path, 600)
			if err != nil {
				t.Fatal(err)
			}
			now := time.Now()
			if armed {
				if err := s.Request(context.Background(), 600, false, now); err != nil {
					t.Fatal(err)
				}
			}
			target.failStop = true
			if err := s.Request(context.Background(), 0, false, now.Add(time.Second)); err == nil {
				t.Fatal("expected failed release")
			}
			// The retry must survive process restart even when there is no armed run.
			s, err = OpenSupervisor(target, path, 600)
			if err != nil {
				t.Fatal(err)
			}
			target.failStop = false
			if err := s.Reconcile(context.Background(), now.Add(16*time.Second)); err != nil {
				t.Fatal(err)
			}
			if target.stops != 2 || s.Status().StopFailing || s.Status().Latched {
				t.Fatalf("failed release not retried: stops=%d status=%+v", target.stops, s.Status())
			}
		})
	}
}

func TestExtensionPreservesCommandAndFailureEvidence(t *testing.T) {
	target := &simulator{failStart: true}
	s, err := OpenSupervisor(target, filepath.Join(t.TempDir(), "run.json"), 600)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	if err := s.Request(context.Background(), 60, false, now); err == nil {
		t.Fatal("expected ambiguous start")
	}
	before := s.Status()
	if err := s.Request(context.Background(), 120, false, now.Add(10*time.Second)); err != nil {
		t.Fatal(err)
	}
	after := s.Status()
	if target.starts != 1 || !after.StopAt.Equal(now.Add(130*time.Second)) {
		t.Fatal("extension wrote another start or used old deadline")
	}
	if !after.LastCommandAt.Equal(*before.LastCommandAt) || after.LastError != before.LastError {
		t.Fatalf("extension erased command evidence: %+v", after)
	}
}

func TestReleaseClearsRequestAndRecordsFailedCommand(t *testing.T) {
	target := &simulator{}
	s, err := OpenSupervisor(target, filepath.Join(t.TempDir(), "run.json"), 600)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	if err := s.Request(context.Background(), 60, false, now); err != nil {
		t.Fatal(err)
	}
	target.failStop = true
	attempted := now.Add(10 * time.Second)
	if err := s.Request(context.Background(), 0, false, attempted); err == nil {
		t.Fatal("expected failed release")
	}
	if !s.Status().LastCommandAt.Equal(attempted) {
		t.Error("failed stop timestamp not recorded")
	}
	if !s.InTransition(attempted.Add(175 * time.Second)) {
		t.Error("failed stop did not reopen transition window")
	}
	target.failStop = false
	if err := s.Request(context.Background(), 0, false, attempted.Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	if s.Status().RequestedAt != nil {
		t.Error("released run retained requestedAt")
	}
}

func TestRemainingTimeMatchesTypeScriptRounding(t *testing.T) {
	s, err := OpenSupervisor(&simulator{}, filepath.Join(t.TempDir(), "run.json"), 600)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	if err := s.Request(context.Background(), 60.4, false, now); err != nil {
		t.Fatal(err)
	}
	if got := s.View(now)["remainingSec"]; got != 60 {
		t.Errorf("remainingSec=%v want 60", got)
	}
	if got := s.SyntheticValues(now)["controlRunRequestMin"]; got != 1 {
		t.Errorf("minutes=%v want 1", got)
	}
}

func TestFirstObservationExtendsActiveTransitionOnly(t *testing.T) {
	for _, commanded := range []bool{false, true} {
		s, err := OpenSupervisor(&simulator{}, filepath.Join(t.TempDir(), "run.json"), 600)
		if err != nil {
			t.Fatal(err)
		}
		now := time.Now()
		if commanded {
			if err := s.Request(context.Background(), 60, false, now); err != nil {
				t.Fatal(err)
			}
		}
		s.Observe(Ownership{Running: true}, now.Add(time.Minute))
		if got := s.InTransition(now.Add(210 * time.Second)); got != commanded {
			t.Errorf("commanded=%v transition=%v", commanded, got)
		}
	}
}

func TestLatchedProbeReportsExtensionWithoutChangingObservation(t *testing.T) {
	target := &simulator{}
	s, err := OpenSupervisor(target, filepath.Join(t.TempDir(), "run.json"), 600)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	if err := s.Request(context.Background(), 60, false, now); err != nil {
		t.Fatal(err)
	}
	observed := Ownership{Mode: 1, Running: true, RemoteStartInput: "closed"}
	s.Observe(observed, now)
	w := httptest.NewRecorder()
	s.SimulatorHandler("site", "secret").ServeHTTP(w, httptest.NewRequest("POST", "/api/usher/control/site/probe", strings.NewReader(`{"passkey":"secret"}`)))
	var body map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if w.Code != 200 || body["wouldStart"] != false || !strings.Contains(body["verdict"].(string), "extends the run") {
		t.Errorf("probe=%s", w.Body.String())
	}
	if *s.observed != observed {
		t.Error("probe mutated poll observation")
	}
	if target.starts != 1 || target.stops != 0 {
		t.Fatal("probe wrote control")
	}
}

func TestFailedReleaseRetryCadenceSurvivesExtension(t *testing.T) {
	target := &simulator{}
	s, err := OpenSupervisor(target, filepath.Join(t.TempDir(), "run.json"), 600)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	if err := s.Request(context.Background(), 60, false, now); err != nil {
		t.Fatal(err)
	}
	target.failStop = true
	if err := s.Request(context.Background(), 0, false, now); err == nil {
		t.Fatal("expected failed release")
	}
	if err := s.Request(context.Background(), 120, false, now.Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	if err := s.Reconcile(context.Background(), now.Add(14*time.Second)); err != nil {
		t.Fatal(err)
	}
	if target.stops != 1 {
		t.Fatal("stop retried before 15-second cadence")
	}
	target.failStop = false
	if err := s.Reconcile(context.Background(), now.Add(15*time.Second)); err != nil {
		t.Fatal(err)
	}
	if target.stops != 2 || s.Status().Latched {
		t.Fatal("extension cancelled the pending stop retry")
	}
}

func TestSimulatorReleaseUsesLastPollWithoutAnotherRead(t *testing.T) {
	for _, input := range []string{"open", "closed", "unknown"} {
		t.Run(input, func(t *testing.T) {
			target := &countingControlTarget{}
			s, err := OpenSupervisor(target, filepath.Join(t.TempDir(), "run.json"), 600)
			if err != nil {
				t.Fatal(err)
			}
			s.Observe(Ownership{Running: true, RemoteStartInput: input}, time.Now())
			w := httptest.NewRecorder()
			s.SimulatorHandler("site", "secret").ServeHTTP(w, httptest.NewRequest("POST", "/api/usher/control/site/run", strings.NewReader(`{"passkey":"secret","runtimeSec":0}`)))
			var result map[string]any
			if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
				t.Fatal(err)
			}
			want := map[string]string{"open": "cool-down", "closed": "remote-start-input", "unknown": "unknown"}[input]
			if w.Code != 200 || result["stillRunning"] != want {
				t.Errorf("release=%s want stillRunning=%s", w.Body.String(), want)
			}
			if target.reads != 0 {
				t.Error("release performed an extra controller read")
			}
		})
	}
}

type countingControlTarget struct {
	simulator
	reads int
}

func (s *countingControlTarget) Preflight(ctx context.Context) (Ownership, error) {
	s.reads++
	return s.simulator.Preflight(ctx)
}

func TestSimulatorHTTPMethodsAndPasskeyParity(t *testing.T) {
	for _, tc := range []struct {
		name, method, path, body, key, header string
		want                                  int
	}{
		{"missing configuration", "GET", "run", "", "", "secret", 503},
		{"probe is post only", "GET", "probe", "", "secret", "secret", 405},
		{"run requires body passkey", "POST", "run", `{"runtimeSec":1}`, "secret", "secret", 401},
		{"probe accepts header", "POST", "probe", "", "secret", "secret", 200},
		{"explicit wrong probe passkey", "POST", "probe", `{"passkey":""}`, "secret", "secret", 401},
	} {
		t.Run(tc.name, func(t *testing.T) {
			target := &simulator{}
			s, err := OpenSupervisor(target, filepath.Join(t.TempDir(), "run.json"), 600)
			if err != nil {
				t.Fatal(err)
			}
			req := httptest.NewRequest(tc.method, "/api/usher/control/site/"+tc.path, strings.NewReader(tc.body))
			req.Header.Set("x-usher-passkey", tc.header)
			w := httptest.NewRecorder()
			s.SimulatorHandler("site", tc.key).ServeHTTP(w, req)
			if w.Code != tc.want {
				t.Errorf("HTTP %d want %d: %s", w.Code, tc.want, w.Body.String())
			}
			if target.starts != 0 || target.stops != 0 {
				t.Fatal("authentication/method check allowed write")
			}
		})
	}
}
