package gousher

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"os"
	"sync"
	"time"
)

// ControlTarget is only implemented by a simulator in the shadow trial. Modbus itself
// rejects every write, even when invoked during startup deadline recovery.
type ControlTarget interface {
	Preflight(context.Context) (Ownership, error)
	Start(context.Context) error
	Stop(context.Context) error
}
type Ownership struct {
	Mode             int    `json:"mode"`
	Running          bool   `json:"running"`
	RemoteStartInput string `json:"remoteStartInput"`
	TelemetryStart   bool   `json:"telemetryStart"`
	TelemetryCancel  bool   `json:"telemetryCancel"`
}
type ControlStatus struct {
	RequestedAt   *time.Time `json:"requestedAt"`
	LastCommandAt *time.Time `json:"lastCommandAt"`
	StopFailing   bool       `json:"stopFailing,omitempty"`
	Latched       bool       `json:"latched"`
	StopAt        *time.Time `json:"stopAt"`
	LastError     string     `json:"lastError,omitempty"`
	ReleasedAt    *time.Time `json:"releasedAt"`
}
type Supervisor struct {
	observed     *Ownership
	transitionAt *time.Time
	mu           sync.Mutex
	target       ControlTarget
	path         string
	maxSeconds   int
	status       ControlStatus
}

func OpenSupervisor(target ControlTarget, path string, maxSeconds int) (*Supervisor, error) {
	s := &Supervisor{target: target, path: path, maxSeconds: maxSeconds}
	b, e := os.ReadFile(path)
	if e == nil {
		if e = json.Unmarshal(b, &s.status); e != nil {
			return nil, e
		}
		if s.status.Latched && s.status.StopAt == nil {
			return nil, errors.New("armed control state has no deadline")
		}
	} else if !os.IsNotExist(e) {
		return nil, e
	}
	return s, nil
}
func (s *Supervisor) persist(st ControlStatus) error {
	b, e := json.Marshal(st)
	if e != nil {
		return e
	}
	return AtomicWrite(s.path, b)
}
func (s *Supervisor) Status() ControlStatus { s.mu.Lock(); defer s.mu.Unlock(); return clone(s.status) }
func (s *Supervisor) Request(ctx context.Context, seconds float64, override bool, now time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if math.IsNaN(seconds) || math.IsInf(seconds, 0) || seconds < 0 || seconds > float64(s.maxSeconds) {
		return errors.New("runtime exceeds generator limit")
	}
	if seconds == 0 {
		return s.stop(ctx, now)
	}
	if !s.status.Latched {
		o, e := s.target.Preflight(ctx)
		if e != nil {
			return errors.New("controller could not be read")
		}
		if o.Mode != 1 {
			return errors.New("module is not in Auto")
		}
		if !o.TelemetryStart || !o.TelemetryCancel {
			return errors.New("module does not support supervised telemetry control")
		}
		if o.Running && !override {
			return errors.New("engine is already running")
		}
	}
	next := s.status
	stop := now.Add(time.Duration(seconds * float64(time.Second)))
	next.StopAt = &stop
	next.Latched = true
	next.ReleasedAt = nil
	next.RequestedAt = &now
	if !s.status.Latched {
		next.LastError = ""
		next.LastCommandAt = &now
		next.StopFailing = false
	}
	if e := s.persist(next); e != nil {
		return e
	}
	wasLatched := s.status.Latched
	s.status = next
	if !wasLatched {
		s.transitionAt = &now
		if e := s.target.Start(ctx); e != nil {
			s.status.LastError = "start may have taken effect; deadline remains armed"
			_ = s.persist(s.status)
			return errors.New(s.status.LastError)
		}
	}
	return nil
}
func (s *Supervisor) stop(ctx context.Context, now time.Time) error {
	s.status.LastCommandAt = &now
	s.transitionAt = &now
	if e := s.target.Stop(ctx); e != nil {
		s.status.LastError = "stop failed; retry pending"
		s.status.StopFailing = true
		_ = s.persist(s.status)
		return e
	}
	next := ControlStatus{ReleasedAt: &now, LastCommandAt: &now}
	if e := s.persist(next); e != nil {
		s.status.LastError = "latch released but persistence failed; retry pending"
		s.status.StopFailing = true
		return e
	}
	s.status = next
	s.transitionAt = &now
	return nil
}
func (s *Supervisor) Reconcile(ctx context.Context, now time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	// Failed releases retry independently of the run deadline, including idle releases.
	if s.status.StopFailing {
		if s.status.LastCommandAt == nil || now.Sub(*s.status.LastCommandAt) >= 15*time.Second {
			return s.stop(ctx, now)
		}
		return nil
	}
	if s.status.Latched && s.status.StopAt != nil && !now.Before(*s.status.StopAt) {
		return s.stop(ctx, now)
	}
	return nil
}
func (s *Supervisor) Run(ctx context.Context) {
	t := time.NewTicker(time.Second)
	defer t.Stop()
	for {
		c, cancel := context.WithTimeout(ctx, 12*time.Second)
		_ = s.Reconcile(c, time.Now())
		cancel()
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

func (s *Supervisor) Observe(ownership Ownership, now time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if (s.observed != nil && s.observed.Running != ownership.Running) ||
		(s.observed == nil && s.transitionAt != nil && now.Sub(*s.transitionAt) < 3*time.Minute) {
		s.transitionAt = &now
	}
	s.observed = &ownership
	if !ownership.Running {
		s.status.ReleasedAt = nil
	}
}
func (s *Supervisor) InTransition(now time.Time) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.transitionAt != nil && now.Sub(*s.transitionAt) < 3*time.Minute
}
func (s *Supervisor) state(now time.Time) string {
	if s.status.StopFailing {
		return "stop-failing"
	}
	if s.status.Latched {
		return "running:hub"
	}
	if s.observed != nil && s.observed.Running {
		if s.status.ReleasedAt != nil {
			if now.Sub(*s.status.ReleasedAt) < 5*time.Minute {
				return "stopping"
			}
			return "latch-released-still-running"
		}
		if s.observed.RemoteStartInput == "closed" {
			return "running:sp-pro"
		}
		return "running:other"
	}
	return "idle"
}
func (s *Supervisor) View(now time.Time) map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	var remaining any
	var lastError any
	if s.status.Latched && s.status.StopAt != nil {
		remaining = s.remainingSeconds(now)
	}
	if s.status.LastError != "" {
		lastError = s.status.LastError
	}
	return map[string]any{"latched": s.status.Latched, "state": s.state(now), "stopAt": s.status.StopAt, "remainingSec": remaining, "requestedAt": s.status.RequestedAt, "lastCommandAt": s.status.LastCommandAt, "lastError": lastError, "maxRuntimeSec": s.maxSeconds}
}
func (s *Supervisor) SyntheticValues(now time.Time) map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	active := 0
	minutes := 0
	var stopAt any
	var lastError any
	if s.status.Latched {
		active = 1
	}
	if s.status.StopAt != nil {
		stopAt = int64(math.Floor(float64(s.status.StopAt.UnixMilli())/1000 + 0.5))
		if s.status.Latched {
			minutes = int(math.Ceil(float64(s.remainingSeconds(now)) / 60))
		}
	}
	if s.status.LastError != "" {
		lastError = s.status.LastError
	}
	return map[string]any{"controlRunActive": active, "controlInhibitActive": 0, "controlStopAt": stopAt, "controlState": s.state(now), "controlLastError": lastError, "controlRunRequestMin": minutes}
}

// TypeScript rounds seconds before deriving the remaining-minute reading.
// Caller holds mu.
func (s *Supervisor) remainingSeconds(now time.Time) int {
	return int(math.Max(0, math.Floor(s.status.StopAt.Sub(now).Seconds()+0.5)))
}

// A confirmed release does not imply a stopped engine. Use the latest poll, as
// TypeScript does; a release must not wait for a second controller round trip.
func (s *Supervisor) stillRunning() any {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.observed == nil || !s.observed.Running {
		return nil
	}
	switch s.observed.RemoteStartInput {
	case "closed":
		return "remote-start-input"
	case "open":
		return "cool-down"
	default:
		return "unknown"
	}
}
