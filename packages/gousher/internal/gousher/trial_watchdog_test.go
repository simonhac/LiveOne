package gousher

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestWatchdogEvidenceAndDurableRuntimeShutdown(t *testing.T) {
	for _, scenario := range []string{"healthy", "missing", "stale", "future", "unhealthy", "wrong-poller", "wrong-revision", "wrong-policy", "missing-result", "malformed", "null", "timeout", "redirect"} {
		t.Run(scenario, func(t *testing.T) {
			now := time.Now().UTC()
			healthy := true
			evidence := SupervisorEvidence{"p", 1, "reviewed-policy", now.Add(-time.Second), &healthy}
			switch scenario {
			case "stale":
				evidence.ObservedAt = now.Add(-61 * time.Second)
			case "future":
				evidence.ObservedAt = now.Add(time.Minute)
			case "unhealthy":
				healthy = false
			case "wrong-poller":
				evidence.PollerID = "other"
			case "wrong-revision":
				evidence.Revision = 2
			case "wrong-policy":
				evidence.PolicyID = "different"
			case "missing-result":
				evidence.Healthy = nil
			}
			source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if !authorized(r, "health-secret") {
					t.Error("health authentication missing")
					w.WriteHeader(401)
					return
				}
				switch scenario {
				case "missing":
					w.WriteHeader(503)
				case "malformed":
					w.Write([]byte("{"))
				case "null":
					w.Write([]byte("null"))
				case "timeout":
					select {
					case <-r.Context().Done():
					case <-time.After(500 * time.Millisecond):
					}
				case "redirect":
					http.Redirect(w, r, "/another", 302)
				default:
					json.NewEncoder(w).Encode(evidence)
				}
			}))
			defer source.Close()
			runtime := testRuntime(t)
			runtime.inspectorToken = "stop-secret"
			runtime.cached.Config.Pollers = []Poller{{ID: "p", Revision: 1}}
			reading, cancel := context.WithCancel(context.Background())
			defer cancel()
			runtime.readerCancels = map[string]readerCancellation{"p": {1, cancel}}
			inspector := httptest.NewServer(runtime.Handler())
			defer inspector.Close()
			t.Setenv("WATCH_HEALTH", "health-secret")
			t.Setenv("WATCH_STOP", "stop-secret")
			cfg := TrialWatchdogConfig{t.TempDir(), "p", 1, "reviewed-policy", source.URL, "WATCH_HEALTH", inspector.URL, "WATCH_STOP", 60}
			watchdog, err := NewTrialWatchdog(cfg)
			if err != nil {
				t.Fatal(err)
			}
			if scenario == "timeout" {
				watchdog.client.Timeout = 100 * time.Millisecond
			}
			err = watchdog.Once(context.Background(), now)
			if scenario == "healthy" {
				if err != nil || reading.Err() != nil {
					t.Fatalf("healthy evidence stopped reader: %v", err)
				}
				return
			}
			if err == nil || reading.Err() == nil {
				t.Fatalf("failure did not stop reader: %v", err)
			}
			runtime.trial = nil
			if err := runtime.loadTrialState(); err != nil {
				t.Fatal(err)
			}
			if !runtime.trial["p"].Disabled || runtime.trial["p"].Reason != "supervision-unavailable" {
				t.Fatal("shutdown not durable")
			}
		})
	}
}

func TestWatchdogRetriesAfterRecoveryAndRestart(t *testing.T) {
	now := time.Now().UTC()
	healthCalls, stopCalls := 0, 0
	health := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { healthCalls++; w.WriteHeader(503) }))
	defer health.Close()
	stop := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		stopCalls++
		if stopCalls == 1 {
			w.WriteHeader(503)
			return
		}
		jsonResponse(w, 200, map[string]any{"disabled": true, "revision": 1})
	}))
	defer stop.Close()
	t.Setenv("WATCH_HEALTH", "h")
	t.Setenv("WATCH_STOP", "s")
	cfg := TrialWatchdogConfig{t.TempDir(), "p", 1, "policy", health.URL, "WATCH_HEALTH", stop.URL, "WATCH_STOP", 60}
	watchdog, err := NewTrialWatchdog(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if watchdog.Once(context.Background(), now) == nil {
		t.Fatal("missing health passed")
	}
	// A recovered health source cannot undo the durable trip, even in a new process.
	watchdog, err = NewTrialWatchdog(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if watchdog.Once(context.Background(), now) == nil {
		t.Fatal("latched assignment passed")
	}
	if healthCalls != 1 || stopCalls != 2 {
		t.Fatalf("health=%d stop=%d", healthCalls, stopCalls)
	}
}

func TestWatchdogStopsEvenWhenLatchStorageFails(t *testing.T) {
	t.Setenv("WATCH_HEALTH", "h")
	t.Setenv("WATCH_STOP", "s")
	calls := 0
	stop := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		jsonResponse(w, 200, map[string]any{"disabled": true, "revision": 1})
	}))
	defer stop.Close()
	path := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(path, []byte("not a directory"), 0600); err != nil {
		t.Fatal(err)
	}
	cfg := TrialWatchdogConfig{path, "p", 1, "policy", stop.URL, "WATCH_HEALTH", stop.URL, "WATCH_STOP", 60}
	watchdog, err := NewTrialWatchdog(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if watchdog.Once(context.Background(), time.Now()) == nil || calls != 1 {
		t.Fatal("storage failure suppressed shutdown")
	}
}

func TestWatchdogRejectsUnacknowledgedShutdown(t *testing.T) {
	for _, ack := range []string{`{}`, `null`, `{"disabled":false,"revision":1}`, `{"disabled":true,"revision":2}`} {
		t.Run(ack, func(t *testing.T) {
			t.Setenv("WATCH_HEALTH", "h")
			t.Setenv("WATCH_STOP", "s")
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == "GET" {
					w.WriteHeader(503)
					return
				}
				w.Write([]byte(ack))
			}))
			defer server.Close()
			cfg := TrialWatchdogConfig{t.TempDir(), "p", 1, "policy", server.URL, "WATCH_HEALTH", server.URL, "WATCH_STOP", 60}
			watchdog, err := NewTrialWatchdog(cfg)
			if err != nil {
				t.Fatal(err)
			}
			err = watchdog.Once(context.Background(), time.Now())
			if err == nil || !strings.Contains(err.Error(), "shutdown not acknowledged") {
				t.Fatalf("bad ack accepted: %v", err)
			}
		})
	}
}
