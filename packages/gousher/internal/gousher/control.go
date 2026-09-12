package gousher

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ControlTarget is only implemented by a simulator in the shadow trial. Modbus itself
// rejects every write, even when invoked during startup deadline recovery.
// Implementations must honor context cancellation. Start verifies SCF support,
// as TypeScript musher does; Stop must never depend on a preceding device read.
type ControlTarget interface {
	Preflight(context.Context) (Ownership, error)
	Start(context.Context) error
	Stop(context.Context) error
}
type Ownership struct {
	ModeUnknown      bool    `json:"-"`
	ModeName         *string `json:"modeName"`
	EngineState      *int    `json:"engineState"`
	EngineStateName  *string `json:"engineStateName"`
	SelectAuto       bool    `json:"selectAuto"`
	SCFMap           []int   `json:"scfMap"`
	Mode             int     `json:"mode"`
	Running          bool    `json:"running"`
	RemoteStartInput string  `json:"remoteStartInput"`
	TelemetryStart   bool    `json:"telemetryStart"`
	TelemetryCancel  bool    `json:"telemetryCancel"`
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
	wake         chan struct{}
	monotonic    func() time.Duration
	monoDeadline *time.Duration
	retryAt      *time.Duration
	unknownState bool
	resumed      bool
	operation    chan struct{}
	observed     *Ownership
	transitionAt *time.Time
	mu           sync.Mutex
	target       ControlTarget
	path         string
	maxSeconds   int
	status       ControlStatus
}

func OpenSupervisor(target ControlTarget, path string, maxSeconds int) (*Supervisor, error) {
	epoch := time.Now()
	s := &Supervisor{monotonic: func() time.Duration { return time.Since(epoch) }, target: target, path: path, maxSeconds: maxSeconds, operation: make(chan struct{}, 1), wake: make(chan struct{}, 1)}
	b, e := os.ReadFile(path)
	if e == nil {
		var fields map[string]json.RawMessage
		if json.Unmarshal(b, &fields) != nil || len(fields["latched"]) == 0 || string(fields["latched"]) == "null" || json.Unmarshal(b, &s.status) != nil || (s.status.Latched && (s.status.StopAt == nil || s.status.StopAt.IsZero())) {
			s.status = ControlStatus{}
			s.unknownState = true
		}
	} else if os.IsNotExist(e) {
		s.unknownState = true
	} else {
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

// Serialize whole operations, including their response snapshots. Waiting callers can cancel.
func (s *Supervisor) acquire(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	select {
	case s.operation <- struct{}{}:
		if err := ctx.Err(); err != nil {
			<-s.operation
			return err
		}
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
func (s *Supervisor) releaseOperation() { <-s.operation }
func (s *Supervisor) Request(ctx context.Context, seconds float64, override bool, now time.Time) error {
	result := s.RequestResult(ctx, seconds, override, now)
	if result["ok"] != true {
		return errors.New(result["reason"].(string))
	}
	return nil
}
func (s *Supervisor) RequestResult(ctx context.Context, seconds float64, override bool, now time.Time) map[string]any {
	if err := s.acquire(ctx); err != nil {
		return map[string]any{"ok": false, "status": 503, "reason": err.Error()}
	}
	defer s.releaseOperation()
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.request(ctx, seconds, override, now)
}
func (s *Supervisor) result(now time.Time, code int, fields map[string]any) map[string]any {
	fields["ok"] = code == 200
	fields["status"] = code
	fields["stopAt"] = controlInstant(s.status.StopAt)
	fields["remainingSec"] = s.view(now)["remainingSec"]
	return fields
}
func (s *Supervisor) readOwnership(ctx context.Context) (Ownership, error) {
	if target, ok := s.target.(interface {
		ReadOwnership(context.Context) (Ownership, error)
	}); ok {
		return target.ReadOwnership(ctx)
	}
	return s.target.Preflight(ctx)
}
func (s *Supervisor) request(ctx context.Context, seconds float64, override bool, now time.Time) map[string]any {
	if math.IsNaN(seconds) || math.IsInf(seconds, 0) || seconds < 0 {
		return s.result(now, 400, map[string]any{"reason": "runtimeSec must be a non-negative number"})
	}
	if seconds == 0 {
		if err := s.stop(ctx, now); err != nil {
			return s.result(now, 500, map[string]any{"reason": fmt.Sprintf("stop failed (%s) — retrying every 15s until confirmed", err), "released": false})
		}
		return s.result(now, 200, map[string]any{"action": "released", "released": true, "stillRunning": s.stillRunningLocked()})
	}
	if seconds > float64(s.maxSeconds) {
		return s.result(now, 400, map[string]any{"reason": fmt.Sprintf("a %gs run is longer than this generator's %ds limit", seconds, s.maxSeconds)})
	}
	wasLatched := s.status.Latched
	var ownership Ownership
	if !wasLatched {
		var err error
		ownership, err = s.readOwnership(ctx)
		if err != nil {
			return s.result(now, 503, map[string]any{"reason": fmt.Sprintf("the controller could not be read (%s), so the hub refused to command it blind", err)})
		}
		if reason := gateStart(ownership, override, s.inCooldown(now)); reason != "" {
			return s.result(now, 409, map[string]any{"reason": reason, "ownership": ownership.wire()})
		}
	}
	next := s.status
	stop := now.Add(time.Duration(seconds * float64(time.Second)))
	next.StopAt = &stop
	next.Latched = true
	next.ReleasedAt = nil
	next.RequestedAt = &now
	if !wasLatched {
		next.LastCommandAt = &now
		next.StopFailing = false
	}
	if err := s.persist(next); err != nil {
		return s.result(now, 500, map[string]any{"reason": "could not persist control state; start refused"})
	}
	s.status = next
	s.unknownState = false
	monoDeadline := s.monotonic() + time.Duration(seconds*float64(time.Second))
	s.monoDeadline = &monoDeadline
	s.notifyDeadline()
	if wasLatched {
		return s.result(now, 200, map[string]any{"action": "extended"})
	}
	s.transitionAt = &now
	if err := s.target.Start(ctx); err != nil {
		s.status.LastError = "start write failed (may still have taken effect): " + err.Error()
		_ = s.persist(s.status)
		return s.result(now, 500, map[string]any{"reason": fmt.Sprintf("start may have taken effect (write failed after delivery was possible); a stop is scheduled for %s", controlInstant(s.status.StopAt)), "reasonMessage": map[string]any{"template": "start may have taken effect (write failed after delivery was possible); a stop is scheduled for {stopAt, time, short}", "values": map[string]any{"stopAt": controlInstant(s.status.StopAt)}}, "ownership": ownership.wire()})
	}
	s.status.LastError = ""
	_ = s.persist(s.status)
	return s.result(now, 200, map[string]any{"action": "started", "ownership": ownership.wire()})
}
func (s *Supervisor) stop(ctx context.Context, now time.Time) error {
	s.status.LastCommandAt = &now
	s.transitionAt = &now
	if e := s.target.Stop(ctx); e != nil {
		s.status.LastError = "stop write failed: " + e.Error()
		s.status.StopFailing = true
		retry := s.monotonic() + 15*time.Second
		s.retryAt = &retry
		_ = s.persist(s.status)
		return e
	}
	next := ControlStatus{ReleasedAt: &now, LastCommandAt: &now}
	if e := s.persist(next); e != nil {
		s.status.LastError = "latch released but persistence failed; retry pending"
		s.status.StopFailing = true
		retry := s.monotonic() + 15*time.Second
		s.retryAt = &retry
		return e
	}
	s.status = next
	s.monoDeadline = nil
	s.retryAt = nil
	s.transitionAt = &now
	return nil
}
func (s *Supervisor) Reconcile(ctx context.Context, now time.Time) error {
	if err := s.acquire(ctx); err != nil {
		return err
	}
	defer s.releaseOperation()
	s.mu.Lock()
	defer s.mu.Unlock()
	// Failed releases retry independently of the run deadline, including idle releases.
	if s.status.StopFailing {
		if s.status.LastCommandAt == nil || now.Sub(*s.status.LastCommandAt) >= 15*time.Second || (s.retryAt != nil && s.monotonic() >= *s.retryAt) {
			return s.stop(ctx, now)
		}
		return nil
	}
	if s.status.Latched && s.status.StopAt != nil && (!now.Round(0).Before(s.status.StopAt.Round(0)) || (s.monoDeadline != nil && s.monotonic() >= *s.monoDeadline)) {
		return s.stop(ctx, now)
	}
	return nil
}
func (s *Supervisor) Run(ctx context.Context) {
	c, cancel := context.WithTimeout(ctx, 12*time.Second)
	_ = s.Resume(c, time.Now())
	cancel()
	for ctx.Err() == nil {
		c, cancel := context.WithTimeout(ctx, 12*time.Second)
		_ = s.Reconcile(c, time.Now())
		cancel()
		timer := time.NewTimer(s.nextWake(time.Now()))
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-s.wake:
			timer.Stop()
		case <-timer.C:
		}
	}
}
func (s *Supervisor) notifyDeadline() {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}
func (s *Supervisor) nextWake(now time.Time) time.Duration {
	s.mu.Lock()
	defer s.mu.Unlock()
	// The periodic pass is a backstop; the actual deadline gets its own wake-up.
	delay := time.Second
	earlier := func(d time.Duration) {
		if d < delay {
			delay = d
		}
	}
	if s.status.StopFailing {
		if s.status.LastCommandAt != nil {
			earlier(s.status.LastCommandAt.Add(15 * time.Second).Sub(now))
		}
		if s.retryAt != nil {
			earlier(*s.retryAt - s.monotonic())
		}
	} else if s.status.Latched && s.status.StopAt != nil {
		earlier(s.status.StopAt.Round(0).Sub(now.Round(0)))
		if s.monoDeadline != nil {
			earlier(*s.monoDeadline - s.monotonic())
		}
	}
	if delay < time.Millisecond {
		return time.Millisecond
	}
	return delay
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
	return s.view(now)
}
func (s *Supervisor) view(now time.Time) map[string]any {
	var remaining any
	var lastError any
	if s.status.Latched && s.status.StopAt != nil {
		remaining = s.remainingSeconds(now)
	}
	if s.status.LastError != "" {
		lastError = s.status.LastError
	}
	return map[string]any{"latched": s.status.Latched, "state": s.state(now), "stopAt": controlInstant(s.status.StopAt), "remainingSec": remaining, "requestedAt": controlInstant(s.status.RequestedAt), "lastCommandAt": controlInstant(s.status.LastCommandAt), "lastError": lastError, "maxRuntimeSec": s.maxSeconds}
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
func (s *Supervisor) stillRunningLocked() any {
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

func controlInstant(t *time.Time) any {
	if t == nil {
		return nil
	}
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}
func (o Ownership) wire() map[string]any {
	var mode any = o.Mode
	var name any
	if o.ModeUnknown {
		mode = nil
	} else if o.ModeName != nil {
		name = *o.ModeName
	} else if n, ok := registerMap.Modes[strconv.Itoa(o.Mode)]; ok {
		name = n
	}
	input := o.RemoteStartInput
	if input == "" {
		input = "unknown"
	}
	var engineState, engineName any
	if o.EngineState != nil {
		engineState = *o.EngineState
	}
	if o.EngineStateName != nil {
		engineName = *o.EngineStateName
	}
	return map[string]any{"mode": mode, "modeName": name, "running": o.Running, "remoteStartInput": input, "engineState": engineState, "engineStateName": engineName}
}
func (s *Supervisor) inCooldown(now time.Time) bool {
	return s.status.ReleasedAt != nil && now.Sub(*s.status.ReleasedAt) < 5*time.Minute
}
func gateStart(o Ownership, override, cooldown bool) string {
	if o.ModeUnknown || o.Mode != 1 {
		mode := o.wire()["modeName"]
		if mode == nil {
			mode = o.wire()["mode"]
		}
		if mode == nil {
			mode = "unreadable"
		}
		return fmt.Sprintf("the module is not in Auto (mode=%v) — a possible local lockout at the panel, and not overridable remotely", mode)
	}
	if o.Running && !override {
		if o.RemoteStartInput == "closed" {
			return "the engine is already running, commanded by the SP-PRO (remote-start input closed)"
		}
		if o.EngineState != nil && (*o.EngineState == 4 || *o.EngineState == 6) {
			return "the engine is cooling down after its last run and will stop shortly"
		}
		if cooldown {
			return "the engine is cooling down after the run that just stopped"
		}
		return "the engine is already running, commanded by an unknown source (remote-start input open)"
	}
	return ""
}
func (s *Supervisor) Probe(ctx context.Context, now time.Time) map[string]any {
	if err := s.acquire(ctx); err != nil {
		return map[string]any{"ok": false, "verdict": "The controller could not be read."}
	}
	defer s.releaseOperation()
	s.mu.Lock()
	defer s.mu.Unlock()
	view := s.view(now)
	o, err := s.target.Preflight(ctx)
	if err != nil {
		view["ok"] = false
		view["verdict"] = fmt.Sprintf("The hub could not read the controller: %s — a run would be refused too.", err)
		return view
	}
	reasons := []string{}
	if gate := gateStart(o, false, s.inCooldown(now)); gate != "" {
		reasons = append(reasons, gate)
	}
	if !o.TelemetryStart {
		reasons = append(reasons, "the module does not advertise Telemetry Start (fn 32)")
	}
	if !o.TelemetryCancel {
		reasons = append(reasons, "the module does not advertise Cancel Telemetry Start (fn 33), so a run could not be stopped")
	}
	view["ok"] = true
	view["wouldStart"] = len(reasons) == 0 && !s.status.Latched
	view["verdict"] = "Ready to start"
	if s.status.Latched {
		view["verdict"] = fmt.Sprintf("Running until %s — starting again extends the run.", controlInstant(s.status.StopAt))
		view["verdictMessage"] = map[string]any{"template": "Running until {stopAt, time, short} — starting again extends the run.", "values": map[string]any{"stopAt": controlInstant(s.status.StopAt)}}
	} else if len(reasons) > 0 {
		view["verdict"] = "A run would be refused: " + strings.Join(reasons, "; ")
	}
	for k, v := range o.wire() {
		view[k] = v
	}
	view["scfSupported"] = map[string]bool{"selectAuto": o.SelectAuto, "telemetryStart": o.TelemetryStart, "telemetryCancel": o.TelemetryCancel}
	words := o.SCFMap
	if words == nil {
		words = []int{}
	}
	view["scfMap"] = append([]int{}, words...)
	return view
}

// Resume performs simulator-only boot recovery. No live target is wired into the trial.
func (s *Supervisor) Resume(ctx context.Context, now time.Time) error {
	if err := s.acquire(ctx); err != nil {
		return err
	}
	defer s.releaseOperation()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.resumed {
		return nil
	}
	if !s.unknownState {
		s.resumed = true
		if s.status.StopFailing || (s.status.Latched && s.status.StopAt != nil && !now.Before(*s.status.StopAt)) {
			return s.stop(ctx, now)
		}
		// A process restart does not constitute a new command or engine transition.
		s.status.LastCommandAt = nil
		s.status.LastError = ""
		return nil
	}
	if err := s.target.Stop(ctx); err != nil {
		s.status.LastError = "defensive stop at boot failed: " + err.Error()
		s.status.StopFailing = true
		s.status.LastCommandAt = &now
	}
	if o, err := s.readOwnership(ctx); err == nil && !o.ModeUnknown && o.Mode == 0 {
		s.status.LastError = "module is in STOP mode at boot with no persisted reason — auto-start is DISABLED; check the panel (possible crash mid-inhibit)"
	}
	if err := s.persist(s.status); err != nil {
		s.status.StopFailing = true
		s.status.LastCommandAt = &now
		s.status.LastError = "defensive stop persistence failed; retry pending"
		retry := s.monotonic() + 15*time.Second
		s.retryAt = &retry
		return err
	}
	s.unknownState = false
	s.resumed = true
	return nil
}
