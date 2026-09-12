package gousher

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

type trialState struct {
	Revision    int       `json:"revision"`
	WindowEnd   time.Time `json:"windowEnd"`
	Consecutive int       `json:"consecutive"`
	Disabled    bool      `json:"disabled"`
	Reason      string    `json:"reason,omitempty"`
}
type readerCancellation struct {
	revision int
	cancel   context.CancelFunc
}
type trialWindow struct {
	PollerID  string         `json:"pollerId"`
	Revision  int            `json:"revision"`
	WindowEnd time.Time      `json:"windowEnd"`
	Baseline  *WindowMetrics `json:"baseline"`
	Current   *WindowMetrics `json:"current"`
}

func (r *Runtime) loadTrialState() error {
	data, e := os.ReadFile(filepath.Join(r.b.DataDir, "trial-state.json"))
	if os.IsNotExist(e) {
		return nil
	}
	if e != nil {
		return e
	}
	if len(data) > 1<<20 {
		return errors.New("trial state exceeds budget")
	}
	if e = json.Unmarshal(data, &r.trial); e != nil {
		return e
	}
	if len(r.trial) > 500 {
		return errors.New("too many trial states")
	}
	return nil
}

// Must hold mu. Persist before acknowledging; cancellation still happens if the
// volume is unavailable, and the error prevents the monitor treating it as durable.
func (r *Runtime) saveTrialState(id string, state trialState) error {
	if r.trial == nil {
		r.trial = map[string]trialState{}
	}
	r.trial[id] = state
	data, e := json.Marshal(r.trial)
	if e == nil {
		e = AtomicWrite(filepath.Join(r.b.DataDir, "trial-state.json"), data)
	}
	if state.Disabled {
		h := r.health[id]
		h.ID = id
		h.Error = "reader-disabled"
		r.health[id] = h
		if active := r.readerCancels[id]; active.revision == state.Revision && active.cancel != nil {
			active.cancel()
		}
	}
	return e
}
func (r *Runtime) disableReader(id string, revision int, reason string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.saveTrialState(id, trialState{Revision: revision, Disabled: true, Reason: reason})
}
func (r *Runtime) trialWindows(w http.ResponseWriter, req *http.Request) {
	if !authorized(req, r.inspectorToken) {
		w.WriteHeader(401)
		return
	}
	if req.Method != "POST" {
		w.WriteHeader(405)
		return
	}
	data, e := readLimited(req.Body, 8192)
	if e != nil {
		w.WriteHeader(413)
		return
	}
	var input trialWindow
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	validMetric := func(m WindowMetrics) bool {
		return !math.IsNaN(m.FailureRate) && !math.IsInf(m.FailureRate, 0) && m.FailureRate >= 0 && m.FailureRate <= 1 && !math.IsNaN(m.P95ReadMS) && !math.IsInf(m.P95ReadMS, 0) && m.P95ReadMS >= 0
	}
	if e = decoder.Decode(&input); e != nil || input.Baseline == nil || input.Current == nil || !validMetric(*input.Baseline) || !validMetric(*input.Current) || input.WindowEnd.IsZero() || !input.WindowEnd.Equal(input.WindowEnd.Truncate(15*time.Minute)) {
		jsonResponse(w, 400, map[string]string{"error": "expected metrics for an aligned 15-minute window"})
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	assigned := false
	for _, p := range r.cached.Config.Pollers {
		if p.ID == input.PollerID && p.Revision == input.Revision && !p.Deleted {
			assigned = true
			break
		}
	}
	if !assigned {
		jsonResponse(w, 409, map[string]string{"error": "unknown or stale poller revision"})
		return
	}
	state := r.trial[input.PollerID]
	if state.Revision != input.Revision {
		state = trialState{Revision: input.Revision}
	}
	if input.WindowEnd.Before(state.WindowEnd) {
		jsonResponse(w, 409, map[string]string{"error": "out-of-order monitoring window"})
		return
	}
	if !input.WindowEnd.Equal(state.WindowEnd) && !state.Disabled {
		if !input.WindowEnd.Equal(state.WindowEnd.Add(15 * time.Minute)) {
			state.Consecutive = 0
		}
		monitor := TrialMonitor{consecutive: state.Consecutive}
		state.Disabled = monitor.Observe(*input.Baseline, *input.Current)
		state.Consecutive = monitor.consecutive
		state.WindowEnd = input.WindowEnd
		if state.Disabled {
			state.Reason = "production-threshold"
		}
	}
	// Retry persistence even for duplicate windows, in case the previous response was a disk failure.
	if e = r.saveTrialState(input.PollerID, state); e != nil {
		jsonResponse(w, 503, map[string]string{"error": "trial state could not be persisted"})
		return
	}
	jsonResponse(w, 200, map[string]any{"disabled": state.Disabled, "consecutive": state.Consecutive, "revision": state.Revision})
}

// Incident reports are supplied by the independent production monitor. They do
// not wait for the slower statistical window gate.
func (r *Runtime) trialIncidents(w http.ResponseWriter, req *http.Request) {
	if !authorized(req, r.inspectorToken) {
		w.WriteHeader(401)
		return
	}
	if req.Method != "POST" {
		w.WriteHeader(405)
		return
	}
	data, e := readLimited(req.Body, 8192)
	if e != nil {
		w.WriteHeader(413)
		return
	}
	var input struct {
		PollerID string `json:"pollerId"`
		Revision int    `json:"revision"`
		Reason   string `json:"reason"`
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if e = decoder.Decode(&input); e != nil || (input.Reason != "session-evicted" && input.Reason != "connection-disruption" && input.Reason != "attempted-write") {
		jsonResponse(w, 400, map[string]string{"error": "invalid incident"})
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	assigned := false
	for _, p := range r.cached.Config.Pollers {
		if p.ID == input.PollerID && p.Revision == input.Revision && !p.Deleted {
			assigned = true
			break
		}
	}
	if !assigned {
		jsonResponse(w, 409, map[string]string{"error": "unknown or stale poller revision"})
		return
	}
	if e = r.saveTrialState(input.PollerID, trialState{Revision: input.Revision, Disabled: true, Reason: input.Reason}); e != nil {
		jsonResponse(w, 503, map[string]string{"error": "trial state could not be persisted"})
		return
	}
	jsonResponse(w, 200, map[string]any{"disabled": true, "revision": input.Revision})
}
