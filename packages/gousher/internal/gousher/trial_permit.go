package gousher

import (
	"context"
	"encoding/json"
	"net/http"
	"time"
)

// Permits are never persisted. Restart requires a fresh boot-bound grant from the
// independent watchdog. A permit cannot clear a durable incident latch.
type trialPermit struct {
	Until     time.Time
	WireUntil time.Time
}
type permitRequest struct {
	PollerID  string    `json:"pollerId"`
	Revision  int       `json:"revision"`
	PolicyID  string    `json:"policyId"`
	BootID    string    `json:"bootId"`
	ExpiresAt time.Time `json:"expiresAt"`
}

func permitKey(poller string, revision int) string {
	return opsKey(TrialOpsPoller{ID: poller, Revision: revision})
}

func (r *Runtime) trialPermitState(w http.ResponseWriter, req *http.Request) {
	if !authorized(req, r.inspectorToken) {
		w.WriteHeader(401)
		return
	}
	if req.Method != "GET" {
		w.WriteHeader(405)
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.permitBootID == "" {
		r.permitBootID = id()
	}
	jsonResponse(w, 200, map[string]any{"bootId": r.permitBootID, "policyId": r.b.TrialPermitPolicyID})
}
func (r *Runtime) trialPermits(w http.ResponseWriter, req *http.Request) {
	if !authorized(req, r.inspectorToken) {
		w.WriteHeader(401)
		return
	}
	if req.Method != "POST" {
		w.WriteHeader(405)
		return
	}
	var input permitRequest
	data, err := readLimited(req.Body, 8192)
	if err != nil || json.Unmarshal(data, &input) != nil {
		w.WriteHeader(400)
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	now := time.Now()
	if r.b.TrialPermitPolicyID == "" || input.PolicyID != r.b.TrialPermitPolicyID || r.permitBootID == "" || input.BootID != r.permitBootID || !input.ExpiresAt.After(now) || input.ExpiresAt.After(now.Add(30*time.Second)) {
		jsonResponse(w, 409, map[string]string{"error": "invalid permit identity or expiry"})
		return
	}
	assigned := false
	for _, p := range r.cached.Config.Pollers {
		if p.ID == input.PollerID && p.Revision == input.Revision && !p.Deleted {
			assigned = true
		}
	}
	state := r.trial[input.PollerID]
	key := permitKey(input.PollerID, input.Revision)
	r.permitMu.Lock()
	old, exists := r.permits[key]
	r.permitMu.Unlock()
	if !assigned || (state.Revision == input.Revision && state.Disabled) || (exists && !old.Until.After(now)) {
		if exists && !old.Until.After(now) {
			_ = r.saveTrialState(input.PollerID, trialState{Revision: input.Revision, Disabled: true, Reason: "supervision-unavailable"})
		}
		jsonResponse(w, 409, map[string]string{"error": "stale, expired or disabled assignment"})
		return
	}
	if exists && !input.ExpiresAt.After(old.WireUntil) {
		jsonResponse(w, 409, map[string]string{"error": "permit expiry must advance"})
		return
	}
	r.permitMu.Lock()
	if r.permits == nil {
		r.permits = map[string]trialPermit{}
	}
	// Add retains the local monotonic clock. Wall clock changes cannot lengthen a grant.
	r.permits[key] = trialPermit{Until: now.Add(input.ExpiresAt.Sub(now)), WireUntil: input.ExpiresAt}
	r.permitMu.Unlock()
	jsonResponse(w, 200, map[string]any{"revision": input.Revision, "expiresAt": input.ExpiresAt, "permitted": true})
}

func (r *Runtime) permitRemaining(p Poller) (time.Duration, bool) {
	r.permitMu.Lock()
	defer r.permitMu.Unlock()
	grant, exists := r.permits[permitKey(p.ID, p.Revision)]
	return time.Until(grant.Until), exists
}
func (r *Runtime) awaitPermit(ctx context.Context, p Poller) bool {
	for ctx.Err() == nil {
		remaining, exists := r.permitRemaining(p)
		if exists {
			if remaining <= 0 {
				_ = r.disableReader(p.ID, p.Revision, "supervision-unavailable")
				return false
			}
			return true
		}
		if !sleep(ctx, 50*time.Millisecond) {
			return false
		}
	}
	return false
}
func (r *Runtime) supervisePermit(ctx context.Context, p Poller, cancelReads context.CancelFunc) {
	for ctx.Err() == nil {
		remaining, exists := r.permitRemaining(p)
		if !exists || remaining <= 0 {
			// Cancellation cannot depend on the runtime storage mutex or a disk write.
			cancelReads()
			_ = r.disableReader(p.ID, p.Revision, "supervision-unavailable")
			return
		}
		if remaining > 50*time.Millisecond {
			remaining = 50 * time.Millisecond
		}
		if !sleep(ctx, remaining) {
			return
		}
	}
}
