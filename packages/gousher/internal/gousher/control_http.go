package gousher

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"net/http"
	"os"
	"time"
)

// SimulatorHandler exposes the Usher wire shape against an injected simulator.
// It is deliberately not mounted by the shadow collector, whose control routes refuse writes.
func (s *Supervisor) SimulatorHandler(siteID, passkey string) http.Handler {
	team, audience := os.Getenv("CF_ACCESS_TEAM_DOMAIN"), os.Getenv("CF_ACCESS_AUD")
	if team == "" && audience == "" {
		return s.simulatorHandler(siteID, passkey)
	}
	verifier, err := NewAccessVerifier("https://"+team, audience, nil)
	if err != nil {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			jsonResponse(w, 503, map[string]string{"error": "Access verification is not configured correctly"})
		})
	}
	return s.SimulatorHandlerWithAccess(siteID, passkey, verifier)
}
func (s *Supervisor) SimulatorHandlerWithAccess(siteID, passkey string, verifier *AccessVerifier) http.Handler {
	next := s.simulatorHandler(siteID, passkey)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if verifier == nil {
			jsonResponse(w, 503, map[string]string{"error": "Access verification is not configured"})
			return
		}
		if err := verifier.Verify(r.Context(), r.Header.Get("Cf-Access-Jwt-Assertion")); err != nil {
			jsonResponse(w, 401, map[string]string{"error": "Access JWT rejected"})
			return
		}
		next.ServeHTTP(w, r)
	})
}
func (s *Supervisor) simulatorHandler(siteID, passkey string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		base := "/api/usher/control/" + siteID + "/"
		if r.URL.Path != base+"run" && r.URL.Path != base+"probe" {
			http.NotFound(w, r)
			return
		}
		if (r.Method != "GET" && r.Method != "POST") || (r.URL.Path == base+"probe" && r.Method != "POST") {
			w.WriteHeader(405)
			return
		}
		var input map[string]any
		if r.Method == "POST" {
			data, err := readLimited(r.Body, 8192)
			if err != nil {
				jsonResponse(w, 413, map[string]string{"error": "request too large"})
				return
			}
			if (len(data) == 0 && r.URL.Path == base+"run") || (len(data) > 0 && (json.Unmarshal(data, &input) != nil || input == nil)) {
				jsonResponse(w, 400, map[string]string{"error": "malformed JSON body"})
				return
			}
		}

		supplied := ""
		if key, ok := input["passkey"].(string); ok {
			supplied = key
		} else if r.Method == "GET" || r.URL.Path == base+"probe" {
			supplied = r.Header.Get("x-usher-passkey")
		}
		if passkey == "" {
			jsonResponse(w, 503, map[string]string{"error": "control passkey is not configured on this hub"})
			return
		}
		provided := sha256.Sum256([]byte(supplied))
		expected := sha256.Sum256([]byte(passkey))
		if supplied == "" || subtle.ConstantTimeCompare(provided[:], expected[:]) != 1 {
			jsonResponse(w, 401, map[string]string{"error": "unauthorized"})
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 12*time.Second)
		defer cancel()
		now := time.Now()
		if r.URL.Path == base+"probe" {
			result := s.Probe(ctx, now)
			code := 200
			if result["ok"] != true {
				code = 503
			}
			jsonResponse(w, code, result)
			return
		}
		if r.Method == "GET" {
			jsonResponse(w, 200, s.View(now))
			return
		}
		seconds, ok := input["runtimeSec"].(float64)
		if !ok {
			jsonResponse(w, 400, map[string]string{"error": "runtimeSec (number, seconds; 0 to stop) is required"})
			return
		}
		override, _ := input["overrideRemoteStart"].(bool)
		// The action, result and status all describe this serialized command. A later
		// request must not turn this response into a snapshot of someone else's command.
		if err := s.acquire(ctx); err != nil {
			jsonResponse(w, 503, map[string]string{"error": "control operation cancelled"})
			return
		}
		s.mu.Lock()
		result := s.request(ctx, seconds, override, time.Now())
		code := result["status"].(int)
		result["status"] = s.view(time.Now())
		s.mu.Unlock()
		s.releaseOperation()
		jsonResponse(w, code, result)
	})
}
