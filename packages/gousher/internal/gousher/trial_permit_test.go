package gousher

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"
)

func grantPermit(t *testing.T, r *Runtime, boot, policy string, revision int, until time.Time) int {
	t.Helper()
	data, _ := json.Marshal(permitRequest{"p", revision, policy, boot, until})
	req := httptest.NewRequest("POST", "/api/trial/permits", bytes.NewReader(data))
	req.Header.Set("Authorization", "Bearer inspector")
	w := httptest.NewRecorder()
	r.Handler().ServeHTTP(w, req)
	return w.Code
}
func TestPermitInhibitsStartupExpiresAndCannotResume(t *testing.T) {
	r := testRuntime(t)
	r.permits = nil
	r.permitBootID = "boot"
	r.inspectorToken = "inspector"
	source := &blockingSource{entered: make(chan struct{}), exited: make(chan struct{})}
	r.factory = func(Poller, map[string]string, string) (Source, error) { return source, nil }
	p := Poller{ID: "p", CollectorID: "c", DeviceID: "d", VendorSiteID: "site", Source: "fronius", Revision: 1, Settings: Settings{PollMS: 2000, PushMS: 60000, Inverters: []Inverter{{Host: "master", Master: true}}}}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := r.apply(ctx, Config{CollectorID: "c", Pollers: []Poller{p}}, nil); err != nil {
		t.Fatal(err)
	}
	select {
	case <-source.entered:
		t.Fatal("read before first permit")
	case <-time.After(80 * time.Millisecond):
	}
	until := time.Now().Add(180 * time.Millisecond)
	for _, test := range []struct {
		boot, policy string
		revision     int
	}{{"old-boot", "test-policy", 1}, {"boot", "wrong", 1}, {"boot", "test-policy", 2}} {
		if grantPermit(t, r, test.boot, test.policy, test.revision, until) != 409 {
			t.Fatal("mismatched grant accepted")
		}
	}
	if grantPermit(t, r, "boot", "test-policy", 1, until) != 200 {
		t.Fatal("grant refused")
	}
	if grantPermit(t, r, "boot", "test-policy", 1, until) != 409 {
		t.Fatal("replayed grant accepted")
	}
	select {
	case <-source.entered:
	case <-time.After(time.Second):
		t.Fatal("permitted reader did not start")
	}
	select {
	case <-source.exited:
	case <-time.After(time.Second):
		t.Fatal("watchdog death did not cancel read")
	}
	<-r.generations["p"].done
	if grantPermit(t, r, "boot", "test-policy", 1, time.Now().Add(time.Second)) != 409 {
		t.Fatal("expired revision resumed")
	}
	r.mu.Lock()
	r.trial = nil
	r.mu.Unlock()
	if err := r.loadTrialState(); err != nil {
		t.Fatal(err)
	}
	if !r.trial["p"].Disabled {
		t.Fatal("expiry not durable")
	}
}
func TestShadowBootstrapRequiresPermitPolicy(t *testing.T) {
	b := Bootstrap{Mode: "shadow"}
	if b.Validate() == nil {
		t.Fatal("shadow without policy accepted")
	}
}

func TestPermitExpiryCancelsBeforeAcquiringStorageMutex(t *testing.T) {
	r := testRuntime(t)
	p := Poller{ID: "p", Revision: 1}
	r.permits[permitKey("p", 1)] = trialPermit{Until: time.Now().Add(80 * time.Millisecond)}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	stopped := make(chan struct{})
	r.mu.Lock()
	go func() { defer close(stopped); r.supervisePermit(ctx, p, cancel) }()
	select {
	case <-ctx.Done():
	case <-time.After(time.Second):
		r.mu.Unlock()
		t.Fatal("storage lock prevented permit cancellation")
	}
	r.mu.Unlock()
	<-stopped
}
func TestPermitsAreNotRecoveredFromCache(t *testing.T) {
	r := testRuntime(t)
	r.b.LiveOneURL = "http://localhost:9000"
	reopened, err := OpenRuntime(r.b, "collector", "receiver", "inspector", r.key)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.release()
	if len(reopened.permits) != 0 || reopened.permitBootID != "" {
		t.Fatal("recovered old permission")
	}
}
