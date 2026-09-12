package gousher

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"time"
)

type ProductionMetrics struct {
	WindowMetrics
	Samples int `json:"samples"`
}
type TrialOpsPoller struct {
	EvidenceLagSec    int               `json:"evidenceLagSec"`
	MinSamples        int               `json:"minSamples"`
	ID                string            `json:"id"`
	Revision          int               `json:"revision"`
	Source            string            `json:"source"`
	VendorSiteID      string            `json:"vendorSiteId"`
	ProductionSiteID  string            `json:"productionSiteId"`
	ReferenceURL      string            `json:"referenceUrl"`
	ReferenceTokenEnv string            `json:"referenceTokenEnv"`
	MetricsURL        string            `json:"metricsUrl"`
	MetricsTokenEnv   string            `json:"metricsTokenEnv"`
	From              time.Time         `json:"from"`
	BaselineEnd       time.Time         `json:"baselineEnd"`
	Baseline          ProductionMetrics `json:"baseline"`
	WindowMS          int               `json:"windowMs"`
}
type TrialOpsConfig struct {
	DataDir           string           `json:"dataDir"`
	ReceiverURL       string           `json:"receiverUrl"`
	ReceiverTokenEnv  string           `json:"receiverTokenEnv"`
	InspectorURL      string           `json:"inspectorUrl"`
	InspectorTokenEnv string           `json:"inspectorTokenEnv"`
	Pollers           []TrialOpsPoller `json:"pollers"`
}
type TrialOps struct {
	cfg    TrialOpsConfig
	client *http.Client
}
type opsCursor struct {
	Fingerprint string    `json:"fingerprint"`
	WindowEnd   time.Time `json:"windowEnd"`
	IncidentEnd time.Time `json:"incidentEnd"`
}

func NewTrialOps(cfg TrialOpsConfig) (*TrialOps, error) {
	if cfg.DataDir == "" || len(cfg.Pollers) == 0 || len(cfg.Pollers) > 32 {
		return nil, errors.New("dataDir and 1–32 pollers required")
	}
	check := func(raw, env string) error {
		u, err := url.Parse(raw)
		if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || env == "" || os.Getenv(env) == "" {
			return errors.New("endpoint or token environment missing")
		}
		if u.Scheme != "https" && !(u.Scheme == "http" && (u.Hostname() == "127.0.0.1" || u.Hostname() == "localhost")) {
			return errors.New("remote operations endpoints require HTTPS")
		}
		return nil
	}
	if err := check(cfg.ReceiverURL, cfg.ReceiverTokenEnv); err != nil {
		return nil, err
	}
	if err := check(cfg.InspectorURL, cfg.InspectorTokenEnv); err != nil {
		return nil, err
	}
	if u, _ := url.Parse(cfg.ReceiverURL); u.Path != "/export" {
		return nil, errors.New("receiver must use its private /export endpoint")
	}
	seen := map[string]bool{}
	for _, p := range cfg.Pollers {
		if p.ID == "" || seen[p.ID] || p.Revision < 1 || p.VendorSiteID == "" || p.ProductionSiteID == "" || p.From.IsZero() || !p.From.Equal(p.From.Truncate(15*time.Minute)) || p.EvidenceLagSec < 0 || p.EvidenceLagSec > 900 || p.MinSamples < 0 || p.MinSamples > 1024 || !p.BaselineEnd.Equal(p.BaselineEnd.Truncate(15*time.Minute)) || math.IsNaN(p.Baseline.FailureRate) || math.IsInf(p.Baseline.FailureRate, 0) || math.IsNaN(p.Baseline.P95ReadMS) || math.IsInf(p.Baseline.P95ReadMS, 0) || p.BaselineEnd.IsZero() || p.BaselineEnd.After(p.From) || p.Baseline.Samples < 1 || p.Baseline.FailureRate < 0 || p.Baseline.FailureRate > 1 || p.Baseline.P95ReadMS <= 0 || p.WindowMS < 0 || p.WindowMS > 60000 {
			return nil, errors.New("invalid assignment or measured production baseline")
		}
		if _, ok := manifests[p.Source]; !ok {
			return nil, errors.New("invalid source")
		}
		seen[p.ID] = true
		if err := check(p.ReferenceURL, p.ReferenceTokenEnv); err != nil {
			return nil, err
		}
		if err := check(p.MetricsURL, p.MetricsTokenEnv); err != nil {
			return nil, err
		}
	}
	return &TrialOps{cfg: cfg, client: &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("operations redirects refused") }}}, nil
}
func (o *TrialOps) fetch(ctx context.Context, method, endpoint, env string, q url.Values, body any, out any) error {
	u, err := url.Parse(endpoint)
	if err != nil {
		return err
	}
	u.RawQuery = q.Encode()
	var data []byte
	if body != nil {
		data, err = json.Marshal(body)
		if err != nil {
			return err
		}
	}
	req, err := http.NewRequestWithContext(ctx, method, u.String(), bytes.NewReader(data))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+os.Getenv(env))
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := o.client.Do(req)
	if err != nil {
		return errors.New("operations endpoint unavailable")
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("operations endpoint HTTP %d", resp.StatusCode)
	}
	data, err = readLimited(resp.Body, 8<<20)
	if err != nil {
		return err
	}
	if err = json.Unmarshal(data, out); err != nil {
		return errors.New("invalid operations response")
	}
	return nil
}
func opsQuery(p TrialOpsPoller, start, end time.Time, kind string) url.Values {
	return url.Values{"pollerId": {p.ID}, "revision": {strconv.Itoa(p.Revision)}, "siteId": {p.ProductionSiteID}, "start": {start.UTC().Format(time.RFC3339Nano)}, "end": {end.UTC().Format(time.RFC3339Nano)}, "kind": {kind}}
}
func opsKey(p TrialOpsPoller) string {
	sum := sha256.Sum256([]byte(p.ID + ":" + strconv.Itoa(p.Revision)))
	return hex.EncodeToString(sum[:16])
}
func opsFingerprint(p TrialOpsPoller) string {
	b, _ := json.Marshal(p)
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}
func (o *TrialOps) MonitorOnce(ctx context.Context, now time.Time) error {
	if err := os.MkdirAll(o.cfg.DataDir, 0700); err != nil {
		return err
	}
	unlock, err := lockInstance(filepath.Join(o.cfg.DataDir, "monitor.lock"))
	if err != nil {
		return err
	}
	defer unlock()
	path := filepath.Join(o.cfg.DataDir, "monitor-state.json")
	state := map[string]opsCursor{}
	if err := loadOpsState(path, &state); err != nil {
		return err
	}
	active := map[string]bool{}
	for _, p := range o.cfg.Pollers {
		active[opsKey(p)] = true
	}
	for key := range state {
		if !active[key] {
			delete(state, key)
		}
	}
	save := func() error {
		data, err := json.Marshal(state)
		if err != nil {
			return err
		}
		if len(data) > 1<<20 {
			return errors.New("operations state too large")
		}
		return AtomicWrite(path, data)
	}
	var problems []error
	for _, p := range o.cfg.Pollers {
		key := opsKey(p)
		cursor, ok := state[key]
		if !ok {
			cursor = opsCursor{Fingerprint: opsFingerprint(p), WindowEnd: p.From, IncidentEnd: p.From}
		}
		if cursor.Fingerprint != opsFingerprint(p) {
			problems = append(problems, errors.New("monitor assignment changed without a new revision"))
			continue
		}
		err := func() error {
			evidenceNow := now.Add(-time.Duration(p.EvidenceLagSec) * time.Second)
			end := evidenceNow
			if end.Sub(cursor.IncidentEnd) > time.Hour {
				end = cursor.IncidentEnd.Add(time.Hour)
			}
			if end.After(cursor.IncidentEnd) {
				var feed struct {
					Role, SiteID string
					Incidents    *[]struct {
						At     time.Time
						Reason string
					}
				}
				if err := o.fetch(ctx, "GET", p.MetricsURL, p.MetricsTokenEnv, opsQuery(p, cursor.IncidentEnd, end, "incidents"), nil, &feed); err != nil {
					return err
				}
				if feed.Role != "production" || feed.SiteID != p.ProductionSiteID || feed.Incidents == nil {
					return errors.New("incident feed is not assigned production source")
				}
				for _, incident := range *feed.Incidents {
					if incident.At.Before(cursor.IncidentEnd) || !incident.At.Before(end) || (incident.Reason != "session-evicted" && incident.Reason != "connection-disruption" && incident.Reason != "attempted-write") {
						return errors.New("invalid production incident")
					}
					var ack struct {
						Disabled bool
						Revision int
					}
					if err := o.fetch(ctx, "POST", o.cfg.InspectorURL+"/api/trial/incidents", o.cfg.InspectorTokenEnv, nil, map[string]any{"pollerId": p.ID, "revision": p.Revision, "reason": incident.Reason}, &ack); err != nil {
						return err
					}
					if !ack.Disabled || ack.Revision != p.Revision {
						return errors.New("incident shutdown not acknowledged")
					}
				}
				cursor.IncidentEnd = end
				state[key] = cursor
				if err := save(); err != nil {
					return err
				}
			}
			// Limit catch-up per cycle so a backlog cannot monopolize incident monitoring.
			for n := 0; n < 4; n++ {
				end := cursor.WindowEnd.Add(15 * time.Minute)
				if end.After(evidenceNow.Truncate(15 * time.Minute)) {
					break
				}
				var feed struct {
					Role, SiteID string
					WindowEnd    time.Time
					Metrics      *ProductionMetrics
				}
				if err := o.fetch(ctx, "GET", p.MetricsURL, p.MetricsTokenEnv, opsQuery(p, cursor.WindowEnd, end, "window"), nil, &feed); err != nil {
					return err
				}
				m := feed.Metrics
				if feed.Role != "production" || feed.SiteID != p.ProductionSiteID || !feed.WindowEnd.Equal(end) || m == nil || m.Samples < max(1, p.MinSamples) || m.FailureRate < 0 || m.FailureRate > 1 || m.P95ReadMS < 0 {
					return errors.New("production window missing or invalid")
				}
				var ack struct {
					Revision int
					Disabled *bool
				}
				if err := o.fetch(ctx, "POST", o.cfg.InspectorURL+"/api/trial/windows", o.cfg.InspectorTokenEnv, nil, trialWindow{PollerID: p.ID, Revision: p.Revision, WindowEnd: end, Baseline: &p.Baseline.WindowMetrics, Current: &m.WindowMetrics}, &ack); err != nil {
					return err
				}
				if ack.Revision != p.Revision || ack.Disabled == nil {
					return errors.New("window acknowledgement revision mismatch")
				}
				cursor.WindowEnd = end
				state[key] = cursor
				if err := save(); err != nil {
					return err
				}
			}
			return nil
		}()
		if err != nil {
			problems = append(problems, fmt.Errorf("poller %s: %w", p.ID, err))
		}
	}
	return errors.Join(problems...)
}

type ComparisonIssue struct{ Report ComparisonReport }

func (e *ComparisonIssue) Error() string { return "daily comparison requires review" }
func (o *TrialOps) CompareDay(ctx context.Context, p TrialOpsPoller, day time.Time) error {
	if !day.Equal(day.UTC().Truncate(24 * time.Hour)) {
		return errors.New("comparison day must start at UTC midnight")
	}
	references := []Batch{}
	actual := []Batch{}
	fixtures := []Fixture{}
	unmatched := 0
	totalBytes := 0
	missingHours := 0
	asOf := time.Now().UTC().Format(time.RFC3339Nano)
	for hour := 0; hour < 24; hour++ {
		start := day.Add(time.Duration(hour) * time.Hour)
		end := start.Add(time.Hour)
		beforeReference, beforeActual := len(references), len(actual)
		for _, reference := range []bool{true, false} {
			cursor := ""
			seen := map[string]bool{}
			for page := 0; ; page++ {
				if page >= 1000 {
					return errors.New("export pagination exceeded")
				}
				q := opsQuery(p, start, end, "fixtures")
				q.Set("cursor", cursor)
				q.Set("asOf", asOf)
				var feed struct {
					Fixtures   []Fixture
					Batches    []Batch
					NextCursor string
					Unmatched  int
				}
				endpoint, env := o.cfg.ReceiverURL, o.cfg.ReceiverTokenEnv
				if reference {
					endpoint, env = p.ReferenceURL, p.ReferenceTokenEnv
				}
				if err := o.fetch(ctx, "GET", endpoint, env, q, nil, &feed); err != nil {
					return err
				}
				unmatched += feed.Unmatched
				if reference {
					for _, f := range feed.Fixtures {
						if f.At.Before(start) || !f.At.Before(end) {
							continue
						}
						if f.Source != p.Source || f.Revision != p.Revision || (f.PollerID != p.ID && f.PollerID != p.ProductionSiteID) {
							return errors.New("reference assignment mismatch")
						}
						data, _ := json.Marshal(f)
						totalBytes += len(data)
						fixtures = append(fixtures, f)
						if !f.Harvest {
							continue
						}
						at := f.At
						if f.ExpectedAt != nil {
							at = *f.ExpectedAt
						}
						if at.Before(day) || !at.Before(day.Add(24*time.Hour)) {
							continue
						}
						references = append(references, Batch{PollerID: p.ID, Revision: p.Revision, VendorSiteID: p.VendorSiteID, MeasurementTime: at, Readings: f.Expected})
					}
				} else {
					for _, b := range feed.Batches {
						if b.MeasurementTime.Before(start) || !b.MeasurementTime.Before(end) {
							continue
						}
						if b.PollerID != p.ID || b.Revision != p.Revision || b.VendorSiteID != p.VendorSiteID {
							return errors.New("trial export assignment mismatch")
						}
						data, _ := json.Marshal(b)
						totalBytes += len(data)
						actual = append(actual, b)
					}
				}
				if totalBytes > 128<<20 || len(fixtures) > 50000 || len(actual) > 50000 {
					return errors.New("daily export budget exceeded")
				}
				if feed.NextCursor == "" {
					break
				}
				if seen[feed.NextCursor] || feed.NextCursor == cursor {
					return errors.New("export cursor did not advance")
				}
				seen[feed.NextCursor] = true
				cursor = feed.NextCursor
			}
		}
		if len(references) == beforeReference || len(actual) == beforeActual {
			missingHours++
		}
	}
	report, differences := CompareWithEvidence(references, actual, time.Duration(p.WindowMS)*time.Millisecond, 20)
	clean := missingHours == 0 && report.Mismatches == 0 && report.UnmatchedReference == 0 && report.UnmatchedActual == 0 && unmatched == 0 && report.Matched > 0
	var evidenceErr error
	selected := []map[string]any{}
	selectedBytes := 0
	if !clean {
		for _, difference := range differences {
			contextFixtures := []Fixture{}
			if difference.Reference != nil {
				at := difference.Reference.MeasurementTime
				for _, f := range fixtures {
					if len(contextFixtures) >= 200 {
						break
					}
					if !f.At.Before(at.Add(-5*time.Minute)) && !f.At.After(at) {
						contextFixtures = append(contextFixtures, f)
					}
				}
			}
			entry := map[string]any{"difference": difference, "rawFixtures": contextFixtures}
			data, _ := json.Marshal(entry)
			if selectedBytes+len(data) > 8<<20 {
				delete(entry, "rawFixtures")
				entry["contextOmitted"] = true
				data, _ = json.Marshal(entry)
			}
			if selectedBytes+len(data) > 8<<20 {
				break
			}
			selected = append(selected, entry)
			selectedBytes += len(data)
		}
		evidence, _ := json.Marshal(map[string]any{"pollerId": p.ID, "revision": p.Revision, "day": day, "selected": selected, "comparison": report, "missingHours": missingHours, "note": "Selected discrepancies with up to five minutes of captured context. Fronius energy replay may need the preceding integration state; this is comparison evidence, not a guaranteed self-contained replay."})
		sum := sha256.Sum256(evidence)
		name := day.Format("2006-01-02") + "-" + hex.EncodeToString(sum[:16]) + ".json"
		if old, err := os.ReadFile(filepath.Join(o.cfg.DataDir, "fixtures", name)); err == nil && bytes.Equal(old, evidence) {
		} else {
			evidenceErr = RetainFixture(o.cfg.DataDir, name, evidence)
		}
	}

	summary := map[string]any{"day": day, "pollerId": p.ID, "revision": p.Revision, "comparison": report, "unmatchedBaseline": unmatched, "clean": clean, "referenceSamples": len(references), "actualSamples": len(actual), "missingHours": missingHours, "selectedDifferences": len(selected), "unselectedDifferences": report.Mismatches + report.UnmatchedReference + report.UnmatchedActual - len(selected)}
	if evidenceErr != nil {
		summary["evidenceError"] = evidenceErr.Error()
	}
	if err := SaveDailySummary(o.cfg.DataDir, summary, day); err != nil {
		return err
	}
	if evidenceErr != nil {
		return evidenceErr
	}
	if !clean {
		return &ComparisonIssue{report}
	}
	return nil
}
