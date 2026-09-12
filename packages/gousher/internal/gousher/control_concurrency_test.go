package gousher

import (
	"context"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

type blockingControlTarget struct {
	simulator
	entered chan struct{}
	unblock chan struct{}
	once    sync.Once
}

func (t *blockingControlTarget) Preflight(ctx context.Context) (Ownership, error) {
	t.once.Do(func() { close(t.entered) })
	select {
	case <-t.unblock:
		return t.simulator.Preflight(ctx)
	case <-ctx.Done():
		return Ownership{}, ctx.Err()
	}
}

func TestConcurrentHTTPStartsHaveAtomicActionsAndResponses(t *testing.T) {
	target := &simulator{}
	s, err := OpenSupervisor(target, filepath.Join(t.TempDir(), "run.json"), 600)
	if err != nil {
		t.Fatal(err)
	}
	h := s.SimulatorHandler("site", "secret")
	const count = 24
	ready := make(chan struct{})
	results := make(chan map[string]any, count)
	for i := 0; i < count; i++ {
		go func() {
			<-ready
			w := httptest.NewRecorder()
			h.ServeHTTP(w, httptest.NewRequest("POST", "/api/usher/control/site/run", strings.NewReader(`{"passkey":"secret","runtimeSec":60}`)))
			var body map[string]any
			json.Unmarshal(w.Body.Bytes(), &body)
			body["code"] = w.Code
			results <- body
		}()
	}
	close(ready)
	started, extended := 0, 0
	for i := 0; i < count; i++ {
		result := <-results
		if result["code"] != 200 {
			t.Fatal(result)
		}
		switch result["action"] {
		case "started":
			started++
		case "extended":
			extended++
		default:
			t.Fatal(result)
		}
		if obj(result["status"])["stopAt"] != result["stopAt"] || obj(result["status"])["latched"] != true {
			t.Fatal("response combined separate commands", result)
		}
	}
	if started != 1 || extended != count-1 || target.starts != 1 {
		t.Fatalf("started=%d extended=%d writes=%d", started, extended, target.starts)
	}
}

func TestQueuedCancelledControlDoesNotWaitOrWrite(t *testing.T) {
	target := &blockingControlTarget{entered: make(chan struct{}), unblock: make(chan struct{})}
	s, err := OpenSupervisor(target, filepath.Join(t.TempDir(), "run.json"), 600)
	if err != nil {
		t.Fatal(err)
	}
	defer close(target.unblock)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	first := make(chan map[string]any, 1)
	go func() { first <- s.Probe(ctx, time.Now()) }()
	<-target.entered
	queued, cancelQueued := context.WithCancel(context.Background())
	result := make(chan error, 1)
	go func() { result <- s.Request(queued, 60, false, time.Now()) }()
	cancelQueued()
	select {
	case err := <-result:
		if err == nil {
			t.Fatal("cancelled command accepted")
		}
	case <-time.After(time.Second):
		t.Fatal("cancelled request stuck behind device operation")
	}
	cancel()
	select {
	case probe := <-first:
		if probe["ok"] != false {
			t.Fatal(probe)
		}
	case <-time.After(time.Second):
		t.Fatal("probe ignored cancellation")
	}
	if target.starts != 0 || target.stops != 0 {
		t.Fatal("cancelled request wrote control")
	}
}

func TestDeadlineReconcileWaitsForProbeAndThenReleases(t *testing.T) {
	target := &blockingControlTarget{entered: make(chan struct{}), unblock: make(chan struct{})}
	s, err := OpenSupervisor(target, filepath.Join(t.TempDir(), "run.json"), 600)
	if err != nil {
		t.Fatal(err)
	}
	// Load an already armed run; the only blocked operation here is the read-only probe.
	now := time.Now()
	deadline := now.Add(-time.Second)
	s.status = ControlStatus{Latched: true, StopAt: &deadline}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	probe := make(chan map[string]any, 1)
	go func() { probe <- s.Probe(ctx, now) }()
	<-target.entered
	done := make(chan error, 1)
	go func() { done <- s.Reconcile(context.Background(), now) }()
	close(target.unblock)
	if result := <-probe; result["latched"] != true {
		t.Fatal("probe mixed pre/post command state")
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if target.stops != 1 || s.Status().Latched {
		t.Fatal("deadline was lost behind probe")
	}
}

func TestControlMonotonicBackstopSurvivesBackwardWallStep(t *testing.T) {
	target := &simulator{}
	s, err := OpenSupervisor(target, filepath.Join(t.TempDir(), "run.json"), 600)
	if err != nil {
		t.Fatal(err)
	}
	elapsed := time.Duration(0)
	s.monotonic = func() time.Duration { return elapsed }
	now := time.Now()
	if err := s.Request(context.Background(), 60, false, now); err != nil {
		t.Fatal(err)
	}
	elapsed = 60 * time.Second
	if err := s.Reconcile(context.Background(), now.Add(-time.Hour)); err != nil {
		t.Fatal(err)
	}
	if target.stops != 1 || s.Status().Latched {
		t.Fatal("backward wall step extended a run")
	}
}

func TestDefensiveBootFailureRetriesAndTrialTransportRejectsRecoveryWrite(t *testing.T) {
	target := &simulator{failStop: true}
	path := filepath.Join(t.TempDir(), "run.json")
	s, err := OpenSupervisor(target, path, 600)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	if err := s.Resume(context.Background(), now); err != nil {
		t.Fatal(err)
	}
	if !s.Status().StopFailing {
		t.Fatal("defensive stop failure not retained")
	}
	target.failStop = false
	s, err = OpenSupervisor(target, path, 600)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Resume(context.Background(), now.Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	if target.stops != 2 || s.Status().StopFailing {
		t.Fatal("restart lost defensive release retry")
	}
	transport := NewModbus("invalid", 502, 1, "shadow")
	rejected := &transportControlTarget{transport: transport}
	trial, err := OpenSupervisor(rejected, filepath.Join(t.TempDir(), "unknown.json"), 600)
	if err != nil {
		t.Fatal(err)
	}
	if err := trial.Resume(context.Background(), now); err != nil {
		t.Fatal(err)
	}
	if !trial.Status().StopFailing || !strings.Contains(trial.Status().LastError, "prohibited") {
		t.Fatal("trial recovery bypassed write rejection")
	}
}

type transportControlTarget struct{ transport *Modbus }

func (t *transportControlTarget) Preflight(context.Context) (Ownership, error) {
	return Ownership{}, errors.New("offline")
}
func (t *transportControlTarget) Start(ctx context.Context) error {
	_, err := t.transport.transaction(ctx, []byte{16, 0, 0, 0, 1, 2, 0, 32})
	return err
}
func (t *transportControlTarget) Stop(ctx context.Context) error {
	_, err := t.transport.transaction(ctx, []byte{16, 0, 0, 0, 1, 2, 0, 33})
	return err
}

func TestDefensiveBootPersistenceFailureRemainsRetryable(t *testing.T) {
	target := &simulator{}
	path := filepath.Join(t.TempDir(), "run.json")
	s, err := OpenSupervisor(target, path, 600)
	if err != nil {
		t.Fatal(err)
	}
	// Block the atomic rename after opening missing state.
	if err := os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	if err := s.Resume(context.Background(), now); err == nil {
		t.Fatal("expected persistence failure")
	}
	if !s.Status().StopFailing {
		t.Fatal("boot persistence failure abandoned retry")
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := s.Reconcile(context.Background(), now.Add(15*time.Second)); err != nil {
		t.Fatal(err)
	}
	if target.stops != 2 || s.Status().StopFailing {
		t.Fatal("boot recovery did not retry")
	}
	reopened, err := OpenSupervisor(target, path, 600)
	if err != nil {
		t.Fatal(err)
	}
	if err := reopened.Resume(context.Background(), now.Add(16*time.Second)); err != nil {
		t.Fatal(err)
	}
	if target.stops != 2 {
		t.Fatal("clean persisted recovery repeated defensive stop")
	}
}

type notifyingControlTarget struct {
	simulator
	stopped chan struct{}
}

func (t *notifyingControlTarget) Stop(ctx context.Context) error {
	err := t.simulator.Stop(ctx)
	select {
	case t.stopped <- struct{}{}:
	default:
	}
	return err
}
func TestSupervisorRunWakesForNewFractionalDeadline(t *testing.T) {
	path := filepath.Join(t.TempDir(), "run.json")
	if err := os.WriteFile(path, []byte(`{"latched":false,"stopAt":null}`), 0600); err != nil {
		t.Fatal(err)
	}
	target := &notifyingControlTarget{stopped: make(chan struct{}, 1)}
	s, err := OpenSupervisor(target, path, 600)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() { defer close(done); s.Run(ctx) }()
	defer func() { cancel(); <-done }()
	if err := s.Request(context.Background(), 0.1, false, time.Now()); err != nil {
		t.Fatal(err)
	}
	select {
	case <-target.stopped:
	case <-time.After(750 * time.Millisecond):
		t.Fatal("fractional deadline waited for the one-second reconcile tick")
	}
	if s.Status().Latched {
		t.Fatal("deadline stop left run armed")
	}
}
