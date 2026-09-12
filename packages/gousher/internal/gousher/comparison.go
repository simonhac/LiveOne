package gousher

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

type ComparisonReport struct {
	Matched            int `json:"matched"`
	Mismatches         int `json:"mismatches"`
	UnmatchedReference int `json:"unmatchedReference"`
	UnmatchedActual    int `json:"unmatchedActual"`
}

// CompareIndependent uses the vendor site identity and nearest available timestamp
// inside a stated sampling window. Unmatched samples never count as mismatches.
func CompareIndependent(reference, actual []Batch, window time.Duration) ComparisonReport {
	report, _ := CompareWithEvidence(reference, actual, window, 0)
	return report
}

type ComparisonDifference struct {
	Kind      string `json:"kind"`
	Reference *Batch `json:"reference,omitempty"`
	Actual    *Batch `json:"actual,omitempty"`
}

func CompareWithEvidence(reference, actual []Batch, window time.Duration, limit int) (ComparisonReport, []ComparisonDifference) {
	report := ComparisonReport{}
	evidence := []ComparisonDifference{}
	retain := func(kind string, ref, got *Batch) {
		if len(evidence) < limit {
			evidence = append(evidence, ComparisonDifference{kind, ref, got})
		}
	}
	groups := map[string][]int{}
	for i, b := range actual {
		groups[b.VendorSiteID] = append(groups[b.VendorSiteID], i)
	}
	for _, indices := range groups {
		sort.SliceStable(indices, func(i, j int) bool {
			return actual[indices[i]].MeasurementTime.Before(actual[indices[j]].MeasurementTime)
		})
	}
	used := make([]bool, len(actual))
	if window < 0 {
		window = 0
	}
	for ri := range reference {
		expected := reference[ri]
		best := -1
		distance := window + 1
		indices := groups[expected.VendorSiteID]
		lower := sort.Search(len(indices), func(i int) bool {
			return !actual[indices[i]].MeasurementTime.Before(expected.MeasurementTime.Add(-window))
		})
		for _, i := range indices[lower:] {
			candidate := actual[i]
			if candidate.MeasurementTime.After(expected.MeasurementTime.Add(window)) {
				break
			}
			if used[i] || candidate.VendorSiteID != expected.VendorSiteID {
				continue
			}
			delta := candidate.MeasurementTime.Sub(expected.MeasurementTime)
			if delta < 0 {
				delta = -delta
			}
			if delta <= window && delta < distance {
				best = i
				distance = delta
			}
		}
		if best < 0 {
			report.UnmatchedReference++
			retain("missing-trial", &reference[ri], nil)
			continue
		}
		used[best] = true
		report.Matched++
		a := append([]Reading(nil), expected.Readings...)
		b := append([]Reading(nil), actual[best].Readings...)
		less := func(v []Reading, i, j int) bool {
			x, _ := v[i]["physicalPathTail"].(string)
			y, _ := v[j]["physicalPathTail"].(string)
			return x < y
		}
		sort.Slice(a, func(i, j int) bool { return less(a, i, j) })
		sort.Slice(b, func(i, j int) bool { return less(b, i, j) })
		if !Compare(a, b) {
			report.Mismatches++
			retain("mismatch", &reference[ri], &actual[best])
		}
	}
	for i, matched := range used {
		if !matched {
			report.UnmatchedActual++
			retain("extra-trial", nil, &actual[i])
		}
	}
	return report, evidence
}

type WindowMetrics struct {
	FailureRate float64 `json:"failureRate"`
	P95ReadMS   float64 `json:"p95ReadMs"`
}
type TrialMonitor struct{ consecutive int }

func (m *TrialMonitor) Observe(baseline, current WindowMetrics) bool {
	bad := current.FailureRate-baseline.FailureRate > 0.01 || (baseline.P95ReadMS > 0 && current.P95ReadMS >= 2*baseline.P95ReadMS)
	if bad {
		m.consecutive++
	} else {
		m.consecutive = 0
	}
	return m.consecutive >= 2
}

// Daily summaries use size AND 45-day retention; unlike the blackbox they expire.
func SaveDailySummary(root string, report any, now time.Time) error {
	dir := filepath.Join(root, "summaries")
	if e := os.MkdirAll(dir, 0700); e != nil {
		return e
	}
	unlock, e := lockInstance(filepath.Join(root, "summaries.lock"))
	if e != nil {
		return e
	}
	defer unlock()
	store, e := OpenStore(dir, 16<<20, 64<<20)
	if e != nil {
		return e
	}
	entries, e := os.ReadDir(dir)
	if e != nil {
		return e
	}
	cutoff := now.AddDate(0, 0, -45)
	for _, entry := range entries {
		if len(entry.Name()) < 10 {
			continue
		}
		day, e := time.Parse("2006-01-02", entry.Name()[:10])
		if e == nil && day.Before(cutoff.Truncate(24*time.Hour)) {
			if e = store.Ack(entry.Name()); e != nil {
				return e
			}
		}
	}
	data, e := json.Marshal(report)
	if e != nil {
		return e
	}
	return store.Put(now.UTC().Format("2006-01-02")+"-"+id()+".json", data, false)
}

// Selected fixtures never evict one another before trial review. Report a full
// budget rather than silently losing the discrepancy that was selected first.
func RetainFixture(root, name string, data []byte) error {
	dir := filepath.Join(root, "fixtures")
	if e := os.MkdirAll(dir, 0700); e != nil {
		return e
	}
	unlock, e := lockInstance(filepath.Join(root, "fixtures.lock"))
	if e != nil {
		return e
	}
	defer unlock()
	if filepath.Base(name) != name || strings.HasPrefix(name, ".") {
		return errors.New("invalid fixture name")
	}
	store, e := OpenStore(dir, 16<<20, 64<<20)
	if e != nil {
		return e
	}
	if store.Stats().Bytes+int64(len(data)) > 16<<20 {
		return errors.New("selected fixture budget exhausted")
	}
	if _, e = os.Stat(filepath.Join(dir, name)); e == nil {
		return errors.New("selected fixture already exists")
	}
	available, e := free(dir)
	if e != nil {
		return e
	}
	if available-int64(len(data)) < 64<<20 {
		return errors.New("free-space reserve reached")
	}
	return AtomicWrite(filepath.Join(dir, name), data)
}
