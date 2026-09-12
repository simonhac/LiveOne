package gousher

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"reflect"
	"time"
)

// Fixtures retain ordered inputs, measurement times, revision and harvest boundaries.
// Cloud normalization uses the supplied virtual time, never the wall clock.
type Fixture struct {
	VendorSiteID string         `json:"vendorSiteId,omitempty"`
	Settings     Settings       `json:"settings"`
	ExpectedAt   *time.Time     `json:"expectedAt,omitempty"`
	Source       string         `json:"source"`
	PollerID     string         `json:"pollerId"`
	Revision     int            `json:"revision"`
	At           time.Time      `json:"at"`
	Raw          map[string]any `json:"raw"`
	Harvest      bool           `json:"harvest"`
	Expected     []Reading      `json:"expected"`
}
type ReplayReport struct {
	Samples    int      `json:"samples"`
	Mismatches int      `json:"mismatches"`
	Unmatched  int      `json:"unmatched"`
	Details    []string `json:"details"`
}

func equalReading(a, b Reading) bool {
	if len(a) != len(b) {
		return false
	}
	for k, x := range a {
		y, ok := b[k]
		if !ok {
			return false
		}
		if k == "value" {
			n, nok := number(x)
			m, mok := number(y)
			if nok && mok {
				if math.Abs(n-m) > 1e-9*math.Max(1, math.Max(math.Abs(n), math.Abs(m))) {
					return false
				}
				continue
			}
		}
		if !reflect.DeepEqual(x, y) {
			return false
		}
	}
	return true
}
func Compare(expected, actual []Reading) bool {
	if len(expected) != len(actual) {
		return false
	}
	for i := range actual {
		if !equalReading(expected[i], actual[i]) {
			return false
		}
	}
	return true
}
func Replay(reader io.Reader) (ReplayReport, error) { return ReplayBatches(reader, nil) }

// ReplayBatches streams computed batches for offline integration and comparisons.
func ReplayBatches(reader io.Reader, emit func(Batch) error) (ReplayReport, error) {
	report := ReplayReport{Details: []string{}}
	scan := bufio.NewScanner(reader)
	scan.Buffer(make([]byte, 65536), 4<<20)
	last := map[string]time.Time{}
	fronius := map[string]*Fronius{}
	froniusSettings := map[string]Settings{}
	for scan.Scan() {
		var f Fixture
		if e := json.Unmarshal(scan.Bytes(), &f); e != nil {
			return report, e
		}
		if f.At.IsZero() || f.Revision < 1 || f.PollerID == "" {
			return report, fmt.Errorf("fixture is missing timing or identity")
		}
		if f.At.Before(last[f.PollerID]) {
			return report, fmt.Errorf("fixture order regressed")
		}
		last[f.PollerID] = f.At
		report.Samples++
		var s Sample
		var e error
		switch f.Source {
		case "deepsea":
			s = Sample{At: f.At, Values: map[string]any{}}
			for _, r := range registerMap.Registers {
				a, ok := f.Raw[r.Key].([]any)
				if !ok {
					continue
				}
				words := make([]uint16, len(a))
				for i, v := range a {
					n, ok := number(v)
					if !ok || n < 0 || n > 65535 || n != math.Trunc(n) {
						return report, fmt.Errorf("invalid register word")
					}
					words[i] = uint16(n)
				}
				s.Values[r.Key] = Decode(r, words)
			}
			s = deriveDSE(s, f.Raw)
		case "fronius":
			src := fronius[f.PollerID]
			if src != nil && len(f.Settings.Inverters) > 0 && !reflect.DeepEqual(connectionSettings(froniusSettings[f.PollerID]), connectionSettings(f.Settings)) {
				src.Close()
				src = nil
			}
			if src == nil {
				if len(f.Settings.Inverters) == 0 {
					return report, fmt.Errorf("Fronius fixture requires inverter settings")
				}
				src = NewFronius(Poller{Settings: f.Settings})
				fronius[f.PollerID] = src
				froniusSettings[f.PollerID] = f.Settings
			}
			for i := range src.inv {
				r := obj(f.Raw[src.inv[i].Config.Host])
				if r == nil {
					continue
				}
				if e = src.inv[i].ingest(r, f.At); e != nil {
					return report, e
				}
			}
			src.latest = src.values()
			s.At = f.At
			if f.Harvest {
				v, ok := src.Harvest(f.At)
				if ok {
					s.Values = v
				}
			}
		default:
			s, e = Normalize(f.Source, f.Raw, f.At)
		}
		if e != nil {
			return report, e
		}
		if !f.Harvest {
			continue
		}
		actual := Readings(f.Source, s.Values)
		if emit != nil && len(actual) > 0 {
			site := f.VendorSiteID
			if site == "" {
				site = f.PollerID
			}
			batchID := id()
			if e := emit(Batch{ID: batchID, PollerID: f.PollerID, Revision: f.Revision, VendorSiteID: site, Action: "store", SessionLabel: "gousher/" + batchID, MeasurementTime: s.At, Readings: actual}); e != nil {
				return report, e
			}
		}
		if (f.ExpectedAt != nil && !s.At.Equal(*f.ExpectedAt)) || !Compare(f.Expected, actual) {
			report.Mismatches++
			if len(report.Details) < 100 {
				report.Details = append(report.Details, fmt.Sprintf("sample %d: %s revision %d", report.Samples, f.PollerID, f.Revision))
			}
		}
	}
	return report, scan.Err()
}
