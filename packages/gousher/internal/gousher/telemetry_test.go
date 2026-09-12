package gousher

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestTelemetryUsesDedicatedCredentialAndOTLPEnvelope(t *testing.T) {
	r := testRuntime(t)
	r.token = "never-export-collector-token"
	var received map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.Header.Get("Authorization") != "Bearer trial-metrics" || req.Header.Get("Content-Type") != "application/json" || req.URL.Path != "/v1/metrics" {
			t.Error("incorrect metrics request", req.Header, req.URL.Path)
		}
		if e := json.NewDecoder(req.Body).Decode(&received); e != nil {
			t.Error(e)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{}`))
	}))
	defer server.Close()
	if e := r.ExportTelemetry(context.Background(), server.URL+"/v1/metrics", "trial-metrics"); e != nil {
		t.Fatal(e)
	}
	data, _ := json.Marshal(received)
	if strings.Contains(string(data), r.token) {
		t.Fatal("collector credential leaked into metrics")
	}
	resources := received["resourceMetrics"].([]any)
	attributes := obj(obj(resources[0])["resource"])["attributes"].([]any)
	if obj(obj(attributes[0])["value"])["stringValue"] != "liveone-gousher" {
		t.Fatal("trial used production service identity", attributes)
	}
	scopes := obj(resources[0])["scopeMetrics"].([]any)
	metrics := obj(scopes[0])["metrics"].([]any)
	if len(metrics) == 0 {
		t.Fatal("no gauges exported")
	}
	point := obj(obj(metrics[0])["gauge"])["dataPoints"].([]any)[0]
	if _, ok := obj(point)["timeUnixNano"].(string); !ok {
		t.Fatal("OTLP 64-bit timestamp must be encoded as a string")
	}
}
func TestTelemetryRejectsPartialSuccessWithoutLeakingResponse(t *testing.T) {
	r := testRuntime(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		_, _ = w.Write([]byte(`{"partialSuccess":{"rejectedDataPoints":"1","errorMessage":"secret-value"}}`))
	}))
	defer server.Close()
	e := r.ExportTelemetry(context.Background(), server.URL+"/v1/metrics", "trial-metrics")
	if e == nil {
		t.Fatal("partial rejection reported as success")
	}
	if strings.Contains(e.Error(), "secret-value") {
		t.Fatal("exporter leaked server response")
	}
}
func TestTelemetryCancellationBoundsStalledExport(t *testing.T) {
	r := testRuntime(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) { io.Copy(io.Discard, req.Body); <-req.Context().Done() }))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Millisecond)
	defer cancel()
	started := time.Now()
	if e := r.ExportTelemetry(ctx, server.URL+"/v1/metrics", "trial-metrics"); e == nil {
		t.Fatal("stalled export succeeded")
	}
	if time.Since(started) > time.Second {
		t.Fatal("export ignored deadline")
	}
}

func TestReadDurationIsExportedWithoutAveragingAwaySlowReads(t *testing.T) {
	r := testRuntime(t)
	r.inspectorToken = "test"
	p := Poller{ID: "p", Source: "deepsea", Settings: Settings{PollMS: 60000, PushMS: 60000}}
	ctx, cancel := context.WithCancel(context.Background())
	g := &generation{p: p, source: &inspectorSource{}, done: make(chan struct{})}
	go r.collect(ctx, g)
	defer func() { cancel(); <-g.done }()
	deadline := time.Now().Add(time.Second)
	for {
		r.mu.Lock()
		ready := r.health[p.ID].CollectionAt != nil
		r.mu.Unlock()
		if ready {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("sample not collected")
		}
		time.Sleep(time.Millisecond)
	}
	req := httptest.NewRequest("GET", "/metrics", nil)
	req.Header.Set("Authorization", "Bearer test")
	w := httptest.NewRecorder()
	r.Handler().ServeHTTP(w, req)
	if !strings.Contains(w.Body.String(), `gousher_read_duration_seconds_count{poller="p"} 1`) || !strings.Contains(w.Body.String(), `gousher_read_duration_seconds_bucket{poller="p",le="+Inf"} 1`) {
		t.Fatal("read duration histogram missing", w.Body.String())
	}
}

func TestNeverSuccessfulReaderBecomesStale(t *testing.T) {
	r := testRuntime(t)
	source := &blockingSource{entered: make(chan struct{}), exited: make(chan struct{})}
	r.factory = func(Poller, map[string]string, string) (Source, error) { return source, nil }
	p := Poller{ID: "p", CollectorID: "c", DeviceID: "d", VendorSiteID: "site", Source: "fronius", Revision: 1, Settings: Settings{PollMS: 2000, PushMS: 60000, Inverters: []Inverter{{Host: "master", Master: true}}}}
	ctx, cancel := context.WithCancel(context.Background())
	if e := r.apply(ctx, Config{CollectorID: "c", Pollers: []Poller{p}}, nil); e != nil {
		cancel()
		t.Fatal(e)
	}
	<-source.entered
	defer func() { cancel(); <-r.generations[p.ID].done }()
	if r.statuses()[0].CollectionStale {
		t.Fatal("new reader already stale")
	}
	if !r.statusesAt(time.Now().Add(2 * time.Minute))[0].CollectionStale {
		t.Fatal("never-successful reader remained healthy indefinitely")
	}
}

func TestTelemetrySeparatesProcessInstances(t *testing.T) {
	r := testRuntime(t)
	instance := func(payload any) string {
		resources := payload.(map[string]any)["resourceMetrics"].([]any)
		attrs := obj(obj(resources[0])["resource"])["attributes"].([]any)
		for _, attribute := range attrs {
			if obj(attribute)["key"] == "service.instance.id" {
				value, _ := obj(obj(attribute)["value"])["stringValue"].(string)
				return value
			}
		}
		return ""
	}
	first := instance(r.telemetryPayload(time.Now()))
	if first == "" {
		t.Fatal("different Gousher processes would share one metric identity")
	}
	if instance(r.telemetryPayload(time.Now())) != first {
		t.Fatal("instance identity changed between exports")
	}
	if instance(testRuntime(t).telemetryPayload(time.Now())) == first {
		t.Fatal("two processes have the same instance identity")
	}
}
