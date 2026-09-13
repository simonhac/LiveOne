package gousher

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"time"
)

// SupervisorEvidence describes a completed production-health observation, not a
// process heartbeat. PolicyID binds evidence to the reviewed qualification policy.
type SupervisorEvidence struct {
	PollerID   string    `json:"pollerId"`
	Revision   int       `json:"revision"`
	PolicyID   string    `json:"policyId"`
	ObservedAt time.Time `json:"observedAt"`
	Healthy    *bool     `json:"healthy"`
}
type TrialWatchdogConfig struct {
	DataDir           string `json:"dataDir"`
	PollerID          string `json:"pollerId"`
	Revision          int    `json:"revision"`
	PolicyID          string `json:"policyId"`
	HealthURL         string `json:"healthUrl"`
	HealthTokenEnv    string `json:"healthTokenEnv"`
	InspectorURL      string `json:"inspectorUrl"`
	InspectorTokenEnv string `json:"inspectorTokenEnv"`
	MaxAgeSec         int    `json:"maxAgeSec"`
}
type TrialWatchdog struct {
	cfg     TrialWatchdogConfig
	client  *http.Client
	tripped bool
}

func NewTrialWatchdog(cfg TrialWatchdogConfig) (*TrialWatchdog, error) {
	if cfg.DataDir == "" || cfg.PollerID == "" || cfg.Revision < 1 || cfg.PolicyID == "" || cfg.MaxAgeSec < 5 || cfg.MaxAgeSec > 120 {
		return nil, errors.New("watchdog requires data directory, assignment, policy and 5–120 second evidence age")
	}
	for _, endpoint := range []struct{ raw, env string }{{cfg.HealthURL, cfg.HealthTokenEnv}, {cfg.InspectorURL, cfg.InspectorTokenEnv}} {
		u, e := url.Parse(endpoint.raw)
		if e != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || endpoint.env == "" || os.Getenv(endpoint.env) == "" {
			return nil, errors.New("watchdog endpoint or token missing")
		}
		if u.Scheme != "https" && !(u.Scheme == "http" && (u.Hostname() == "127.0.0.1" || u.Hostname() == "localhost")) {
			return nil, errors.New("watchdog remote endpoints require HTTPS")
		}
	}
	u, _ := url.Parse(cfg.InspectorURL)
	if u.Path != "" {
		return nil, errors.New("inspector URL must be an origin without a path")
	}
	return &TrialWatchdog{cfg: cfg, client: &http.Client{Timeout: 3 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("watchdog redirects refused") }}}, nil
}
func (w *TrialWatchdog) request(ctx context.Context, method, endpoint, tokenEnv string, body any, out any) error {
	var data []byte
	var err error
	if body != nil {
		data, err = json.Marshal(body)
		if err != nil {
			return err
		}
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint, bytes.NewReader(data))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+os.Getenv(tokenEnv))
	req.Header.Set("Cache-Control", "no-cache")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := w.client.Do(req)
	if err != nil {
		return errors.New("watchdog endpoint unavailable")
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("watchdog endpoint HTTP %d", resp.StatusCode)
	}
	data, err = readLimited(resp.Body, 8192)
	if err != nil {
		return err
	}
	if err = json.Unmarshal(data, out); err != nil {
		return errors.New("invalid watchdog response")
	}
	return nil
}

// Once permanently latches an assignment on missing/invalid/unhealthy evidence.
// It retries the stop even after evidence recovers and after process restarts.
// It never enables a reader. An unreachable collector requires a separate host
// stop mechanism or collector-side expiring permit before live qualification.
func (w *TrialWatchdog) Once(ctx context.Context, now time.Time) error {
	started := time.Now()
	if err := os.MkdirAll(w.cfg.DataDir, 0700); err != nil {
		w.tripped = true
	}
	path := filepath.Join(w.cfg.DataDir, "watchdog-"+opsKey(TrialOpsPoller{ID: w.cfg.PollerID, Revision: w.cfg.Revision})+".json")
	// Any existing latch (including corrupt state) fails closed. It is never cleared here.
	if _, err := os.Stat(path); err == nil || !os.IsNotExist(err) {
		w.tripped = true
	}
	var healthErr error
	if !w.tripped {
		var evidence SupervisorEvidence
		healthErr = w.request(ctx, "GET", w.cfg.HealthURL, w.cfg.HealthTokenEnv, nil, &evidence)
		checkedAt := now.Add(time.Since(started))
		if healthErr == nil && (evidence.PollerID != w.cfg.PollerID || evidence.Revision != w.cfg.Revision || evidence.PolicyID != w.cfg.PolicyID || evidence.Healthy == nil || !*evidence.Healthy || evidence.ObservedAt.IsZero() || evidence.ObservedAt.After(checkedAt) || checkedAt.Sub(evidence.ObservedAt) > time.Duration(w.cfg.MaxAgeSec)*time.Second) {
			healthErr = errors.New("supervisor evidence missing, stale, unhealthy or mismatched")
		}
		w.tripped = healthErr != nil
	}
	if !w.tripped {
		return nil
	}
	data, _ := json.Marshal(map[string]any{"pollerId": w.cfg.PollerID, "revision": w.cfg.Revision, "policyId": w.cfg.PolicyID, "trippedAt": now.UTC()})
	persistErr := AtomicWrite(path, data)
	// Use a fresh bounded context if health retrieval exhausted its context. A
	// failed observation must not consume the shutdown request's entire budget.
	stopCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 3*time.Second)
	defer cancel()
	var ack struct {
		Disabled bool `json:"disabled"`
		Revision int  `json:"revision"`
	}
	stopErr := w.request(stopCtx, "POST", w.cfg.InspectorURL+"/api/trial/incidents", w.cfg.InspectorTokenEnv, map[string]any{"pollerId": w.cfg.PollerID, "revision": w.cfg.Revision, "reason": "supervision-unavailable"}, &ack)
	if stopErr == nil && (!ack.Disabled || ack.Revision != w.cfg.Revision) {
		stopErr = errors.New("watchdog shutdown not acknowledged")
	}
	return errors.Join(errors.New("watchdog latched: trial must remain stopped"), healthErr, persistErr, stopErr)
}
