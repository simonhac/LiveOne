package gousher

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"runtime"
	"strconv"
	"time"
)

// OTLP/HTTP JSON: https://opentelemetry.io/docs/specs/otlp/#json-protobuf-encoding
// This exporter keeps no queue. Each attempt reports the newest bounded snapshot;
// failed monitoring exports never block collection or compete with its spool.
func (r *Runtime) telemetryPayload(now time.Time) any {
	r.mu.Lock()
	if r.telemetryInstance == "" {
		r.telemetryInstance = id()
	}
	instance := r.telemetryInstance
	r.mu.Unlock()
	var memory runtime.MemStats
	runtime.ReadMemStats(&memory)
	sp, bb := r.spool.Stats(), r.blackbox.Stats()
	metrics := []any{}
	gauge := func(name, unit string, value float64, poller string) {
		point := map[string]any{"timeUnixNano": strconv.FormatInt(now.UnixNano(), 10), "asDouble": value}
		if poller != "" {
			point["attributes"] = []any{map[string]any{"key": "poller.id", "value": map[string]any{"stringValue": poller}}}
		}
		metrics = append(metrics, map[string]any{"name": name, "unit": unit, "gauge": map[string]any{"dataPoints": []any{point}}})
	}
	gauge("gousher.heap.bytes", "By", float64(memory.HeapAlloc), "")
	gauge("gousher.runtime.bytes", "By", float64(memory.Sys), "")
	gauge("gousher.goroutines", "{goroutine}", float64(runtime.NumGoroutine()), "")
	gauge("gousher.spool.bytes", "By", float64(sp.Bytes), "")
	gauge("gousher.blackbox.bytes", "By", float64(bb.Bytes), "")
	gauge("gousher.spool.pending", "{batch}", float64(sp.Count), "")
	gauge("gousher.spool.dropped", "{batch}", float64(sp.Lost.Count), "")
	for _, h := range r.statuses() {
		stale := 0.0
		if h.CollectionStale {
			stale = 1
		}
		gauge("gousher.collection.stale", "1", stale, h.ID)
		if h.CollectionAt != nil {
			gauge("gousher.collection.last_success", "s", float64(h.CollectionAt.Unix()), h.ID)
		}
		if h.DeliveryAt != nil {
			gauge("gousher.delivery.last_success", "s", float64(h.DeliveryAt.Unix()), h.ID)
		}
	}
	for poller, m := range r.readMetricsSnapshot() {
		buckets := []string{}
		for _, count := range m.Buckets {
			buckets = append(buckets, strconv.FormatUint(count, 10))
		}
		metrics = append(metrics, map[string]any{"name": "gousher.collection.duration", "unit": "s", "histogram": map[string]any{
			"aggregationTemporality": 2, "dataPoints": []any{map[string]any{
				"startTimeUnixNano": strconv.FormatInt(m.Started.UnixNano(), 10), "timeUnixNano": strconv.FormatInt(now.UnixNano(), 10),
				"attributes": []any{map[string]any{"key": "poller.id", "value": map[string]any{"stringValue": poller}}},
				"count":      strconv.FormatUint(m.Count, 10), "sum": m.Seconds, "explicitBounds": readBounds, "bucketCounts": buckets,
			}},
		}})
		gauge("gousher.collection.failed", "{read}", float64(m.Failed), poller)
	}
	return map[string]any{"resourceMetrics": []any{map[string]any{
		"resource":     map[string]any{"attributes": []any{map[string]any{"key": "service.name", "value": map[string]any{"stringValue": "liveone-gousher"}}, map[string]any{"key": "service.instance.id", "value": map[string]any{"stringValue": instance}}}},
		"scopeMetrics": []any{map[string]any{"scope": map[string]string{"name": "liveone/gousher"}, "metrics": metrics}},
	}}}
}
func (r *Runtime) ExportTelemetry(ctx context.Context, endpoint, token string) error {
	u, e := url.Parse(endpoint)
	if e != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || token == "" || (u.Scheme != "https" && !(u.Scheme == "http" && (u.Hostname() == "127.0.0.1" || u.Hostname() == "localhost"))) {
		return errors.New("invalid telemetry endpoint or missing dedicated token")
	}
	data, e := json.Marshal(r.telemetryPayload(time.Now()))
	if e != nil {
		return errors.New("telemetry encoding failed")
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	req, e := http.NewRequestWithContext(ctx, "POST", endpoint, bytes.NewReader(data))
	if e != nil {
		return errors.New("invalid telemetry request")
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	client := &http.Client{Timeout: 5 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	defer client.CloseIdleConnections()
	res, e := client.Do(req)
	if e != nil {
		return errors.New("telemetry transport failed")
	}
	defer res.Body.Close()
	body, e := readLimited(res.Body, 8192)
	if e != nil {
		return errors.New("telemetry response exceeds limit")
	}
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("telemetry HTTP %d", res.StatusCode)
	}
	var response struct {
		PartialSuccess struct {
			Rejected json.RawMessage `json:"rejectedDataPoints"`
			Message  string          `json:"errorMessage"`
		} `json:"partialSuccess"`
	}
	if json.Unmarshal(body, &response) != nil {
		return errors.New("invalid telemetry response")
	}
	rejected := string(response.PartialSuccess.Rejected)
	if (rejected != "" && rejected != "0" && rejected != `"0"`) || response.PartialSuccess.Message != "" {
		return errors.New("telemetry partially rejected")
	}
	return nil
}

// RunTelemetry uses only explicitly supplied trial monitoring credentials. The
// process owns its lifecycle; errors are observable without stopping readers.
func (r *Runtime) RunTelemetry(ctx context.Context, endpoint, token string, report func(error)) {
	if endpoint == "" && token == "" {
		return
	}
	for ctx.Err() == nil {
		e := r.ExportTelemetry(ctx, endpoint, token)
		if ctx.Err() != nil {
			return
		}
		r.mu.Lock()
		r.telemetryError = ""
		if e != nil {
			r.telemetryError = e.Error()
		}
		r.mu.Unlock()
		if report != nil {
			report(e)
		}
		if !sleep(ctx, time.Minute) {
			return
		}
	}
}
