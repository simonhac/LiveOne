package gousher

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

type traceTarget struct {
	ownership                     Ownership
	starts, stops                 int
	failRead, failStart, failStop bool
}

func (t *traceTarget) ReadOwnership(context.Context) (Ownership, error) {
	if t.failRead {
		return Ownership{}, errors.New("read timeout")
	}
	return t.ownership, nil
}
func (t *traceTarget) Preflight(ctx context.Context) (Ownership, error) { return t.ReadOwnership(ctx) }
func (t *traceTarget) Start(context.Context) error {
	t.starts++
	if t.failStart {
		return errors.New("write timeout")
	}
	return nil
}
func (t *traceTarget) Stop(context.Context) error {
	t.stops++
	if t.failStop {
		return errors.New("write timeout")
	}
	return nil
}

func TestSharedTypeScriptControlTraces(t *testing.T) {
	data, err := os.ReadFile("testdata/control-traces.json")
	if err != nil {
		t.Fatal(err)
	}
	var traces []struct {
		Name         string
		InitialState *string
		Steps        []struct {
			Op                            string
			AdvanceMs                     int
			RuntimeSec                    float64
			Override                      bool
			Ownership                     map[string]any
			FailRead, FailStart, FailStop *bool
			SCF                           map[string]bool
			Expected                      map[string]any
		}
	}
	if err := json.Unmarshal(data, &traces); err != nil {
		t.Fatal(err)
	}
	for _, trace := range traces {
		t.Run(trace.Name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "run.json")
			if trace.InitialState != nil {
				if err := os.WriteFile(path, []byte(*trace.InitialState), 0600); err != nil {
					t.Fatal(err)
				}
			}
			target := &traceTarget{ownership: Ownership{Mode: 1, RemoteStartInput: "open", SelectAuto: true, TelemetryStart: true, TelemetryCancel: true, SCFMap: []int{16384, 0, 49152, 0, 0, 0, 0, 0}}}
			s, err := OpenSupervisor(target, path, 600)
			if err != nil {
				t.Fatal(err)
			}
			now, _ := time.Parse(time.RFC3339, "2026-09-12T00:00:00Z")
			for i, step := range trace.Steps {
				now = now.Add(time.Duration(step.AdvanceMs) * time.Millisecond)
				if step.Ownership != nil {
					b, _ := json.Marshal(step.Ownership)
					if err := json.Unmarshal(b, &target.ownership); err != nil {
						t.Fatal(err)
					}
					if mode, ok := step.Ownership["mode"]; ok {
						target.ownership.ModeUnknown = mode == nil
					}
				}
				if step.SCF != nil {
					target.ownership.SelectAuto = step.SCF["selectAuto"]
					target.ownership.TelemetryStart = step.SCF["telemetryStart"]
					target.ownership.TelemetryCancel = step.SCF["telemetryCancel"]
				}
				if step.FailRead != nil {
					target.failRead = *step.FailRead
				}
				if step.FailStart != nil {
					target.failStart = *step.FailStart
				}
				if step.FailStop != nil {
					target.failStop = *step.FailStop
				}
				var result any
				switch step.Op {
				case "request":
					result = s.RequestResult(context.Background(), step.RuntimeSec, step.Override, now)
				case "probe":
					result = s.Probe(context.Background(), now)
				case "observe":
					s.Observe(target.ownership, now)
				case "reconcile":
					_ = s.Reconcile(context.Background(), now)
				case "restart":
					s, err = OpenSupervisor(target, path, 600)
					if err != nil {
						t.Fatal(err)
					}
					if err = s.Resume(context.Background(), now); err != nil {
						t.Fatal(err)
					}
				}
				got := map[string]any{"result": result, "status": s.View(now), "values": s.SyntheticValues(now), "transition": s.InTransition(now), "starts": target.starts, "stops": target.stops}
				b, _ := json.Marshal(got)
				var normalized map[string]any
				json.Unmarshal(b, &normalized)
				if !reflect.DeepEqual(normalized, step.Expected) {
					want, _ := json.Marshal(step.Expected)
					t.Fatalf("step %d %s\ngot  %s\nwant %s", i, step.Op, b, want)
				}
			}
		})
	}
}
