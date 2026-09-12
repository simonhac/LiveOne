package gousher

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// SimulatorHandler exposes the Usher wire shape against an injected simulator.
// It is deliberately not mounted by the shadow collector, whose control routes refuse writes.
func (s *Supervisor) SimulatorHandler(siteID, passkey string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		base := "/api/usher/control/" + siteID + "/"
		if r.URL.Path != base+"run" && r.URL.Path != base+"probe" {
			http.NotFound(w, r)
			return
		}
		if r.Method != "GET" && r.Method != "POST" {
			w.WriteHeader(405)
			return
		}
		var input struct {
			Passkey    string   `json:"passkey"`
			RuntimeSec *float64 `json:"runtimeSec"`
			Override   bool     `json:"overrideRemoteStart"`
		}
		if r.Method == "POST" {
			data, e := readLimited(r.Body, 8192)
			if e != nil {
				jsonResponse(w, 413, map[string]string{"error": "request too large"})
				return
			}
			if len(data) > 0 && json.Unmarshal(data, &input) != nil {
				jsonResponse(w, 400, map[string]string{"error": "malformed JSON body"})
				return
			}
		}
		if input.Passkey == "" {
			input.Passkey = r.Header.Get("x-usher-passkey")
		}
		provided := sha256.Sum256([]byte(input.Passkey))
		expected := sha256.Sum256([]byte(passkey))
		if passkey == "" || subtle.ConstantTimeCompare(provided[:], expected[:]) != 1 {
			jsonResponse(w, 401, map[string]string{"error": "unauthorized"})
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 12*time.Second)
		defer cancel()
		now := time.Now()
		view := s.View(now)
		if strings.HasSuffix(r.URL.Path, "/probe") {
			ownership, e := s.target.Preflight(ctx)
			if e != nil {
				view["ok"] = false
				view["verdict"] = "The controller could not be read."
				jsonResponse(w, 503, view)
				return
			}
			s.Observe(ownership, now)
			view = s.View(now)
			canStart := ownership.Mode == 1 && ownership.TelemetryStart && ownership.TelemetryCancel && (!ownership.Running || s.Status().Latched)
			view["ok"] = true
			view["wouldStart"] = canStart
			view["verdict"] = "The simulator is ready for a supervised run."
			if !canStart {
				view["verdict"] = "A supervised run is not currently allowed."
			}
			view["mode"] = ownership.Mode
			view["modeName"] = registerMap.Modes[strconv.Itoa(ownership.Mode)]
			view["remoteStartInput"] = ownership.RemoteStartInput
			view["running"] = ownership.Running
			view["scfSupported"] = map[string]bool{"selectAuto": true, "telemetryStart": ownership.TelemetryStart, "telemetryCancel": ownership.TelemetryCancel}
			view["scfMap"] = []int{}
			jsonResponse(w, 200, view)
			return
		}
		if r.Method == "GET" {
			jsonResponse(w, 200, view)
			return
		}
		if input.RuntimeSec == nil || *input.RuntimeSec < 0 || *input.RuntimeSec > float64(s.maxSeconds) {
			jsonResponse(w, 400, map[string]string{"error": "runtimeSec must be between zero and the generator limit"})
			return
		}
		before := s.Status()
		e := s.Request(ctx, *input.RuntimeSec, input.Override, now)
		view = s.View(time.Now())
		result := map[string]any{"ok": e == nil, "status": view, "stopAt": view["stopAt"], "remainingSec": view["remainingSec"]}
		if e != nil {
			status := 500
			switch e.Error() {
			case "controller could not be read":
				status = 503
			case "module is not in Auto", "module does not support supervised telemetry control", "engine is already running":
				status = 409
			}
			result["reason"] = e.Error()
			jsonResponse(w, status, result)
			return
		}
		action := "started"
		if before.Latched {
			action = "extended"
		}
		if *input.RuntimeSec == 0 {
			action = "released"
			result["released"] = true
			ownership, readErr := s.target.Preflight(ctx)
			if readErr == nil {
				s.Observe(ownership, time.Now())
				result["status"] = s.View(time.Now())
				if ownership.Running {
					reason := "cool-down"
					if ownership.RemoteStartInput == "closed" {
						reason = "remote-start-input"
					}
					result["stillRunning"] = reason
				}
			}
		}
		result["action"] = action
		jsonResponse(w, 200, result)
	})
}
