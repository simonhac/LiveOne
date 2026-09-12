package gousher

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

func authorized(r *http.Request, token string) bool {
	if token == "" {
		return false
	}
	a := sha256.Sum256([]byte(r.Header.Get("Authorization")))
	b := sha256.Sum256([]byte("Bearer " + token))
	return subtle.ConstantTimeCompare(a[:], b[:]) == 1
}
func jsonResponse(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func (r *Runtime) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/trial/windows", r.trialWindows)
	mux.HandleFunc("/api/trial/incidents", r.trialIncidents)
	mux.HandleFunc("/metrics", func(w http.ResponseWriter, req *http.Request) {
		if !authorized(req, r.inspectorToken) {
			w.WriteHeader(401)
			return
		}
		w.Header().Set("Content-Type", "text/plain; version=0.0.4")
		sp := r.spool.Stats()
		bb := r.blackbox.Stats()
		var memory runtime.MemStats
		runtime.ReadMemStats(&memory)
		fmt.Fprintf(w, "gousher_spool_bytes %d\ngousher_blackbox_bytes %d\ngousher_pending_batches %d\ngousher_dropped_batches_total %d\ngousher_heap_bytes %d\ngousher_goroutines %d\n", sp.Bytes, bb.Bytes, sp.Count, sp.Lost.Count, memory.HeapAlloc, runtime.NumGoroutine())
		fmt.Fprintln(w, "# TYPE gousher_read_duration_seconds histogram")
		for poller, m := range r.readMetricsSnapshot() {
			label := strconv.Quote(poller)
			total := uint64(0)
			for i, count := range m.Buckets {
				total += count
				bound := "+Inf"
				if i < len(readBounds) {
					bound = strconv.FormatFloat(readBounds[i], 'g', -1, 64)
				}
				fmt.Fprintf(w, "gousher_read_duration_seconds_bucket{poller=%s,le=%q} %d\n", label, bound, total)
			}
			fmt.Fprintf(w, "gousher_read_duration_seconds_count{poller=%s} %d\ngousher_read_duration_seconds_sum{poller=%s} %g\ngousher_read_failures_total{poller=%s} %d\n", label, m.Count, label, m.Seconds, label, m.Failed)
		}
		for _, h := range r.statuses() {
			label := strconv.Quote(h.ID)
			if h.CollectionAt != nil {
				fmt.Fprintf(w, "gousher_collection_last_success_seconds{poller=%s} %d\n", label, h.CollectionAt.Unix())
			}
			if h.DeliveryAt != nil {
				fmt.Fprintf(w, "gousher_delivery_last_success_seconds{poller=%s} %d\n", label, h.DeliveryAt.Unix())
			}
			stale := 0
			if h.CollectionStale {
				stale = 1
			}
			fmt.Fprintf(w, "gousher_collection_stale{poller=%s} %d\n", label, stale)
		}
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, req *http.Request) {
		if req.URL.Path != "/" {
			http.NotFound(w, req)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		b, _ := assets.ReadFile("assets/index.html")
		_, _ = w.Write(b)
	})
	mux.HandleFunc("/api/usher/state", func(w http.ResponseWriter, req *http.Request) {
		if !authorized(req, r.inspectorToken) {
			jsonResponse(w, 401, map[string]string{"error": "unauthorized"})
			return
		}
		jsonResponse(w, 200, r.snapshot())
	})
	mux.HandleFunc("/api/usher/stream", func(w http.ResponseWriter, req *http.Request) {
		if !authorized(req, r.inspectorToken) {
			jsonResponse(w, 401, map[string]string{"error": "unauthorized"})
			return
		}
		f, ok := w.(http.Flusher)
		if !ok {
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-store")
		t := time.NewTicker(2 * time.Second)
		defer t.Stop()
		for {
			b, _ := json.Marshal(r.snapshot())
			_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(10 * time.Second))
			if _, e := fmt.Fprintf(w, "data: %s\n\n", b); e != nil {
				return
			}
			f.Flush()
			select {
			case <-req.Context().Done():
				return
			case <-t.C:
			}
		}
	})
	mux.HandleFunc("/api/usher/control/", func(w http.ResponseWriter, req *http.Request) {
		if !authorized(req, r.inspectorToken) {
			jsonResponse(w, 401, map[string]string{"error": "unauthorized"})
			return
		}
		jsonResponse(w, 403, map[string]any{"ok": false, "verdict": "Generator control is disabled during the shadow trial. TypeScript Usher remains the live controller."})
	})
	return mux
}
func (r *Runtime) snapshot() map[string]any {
	hs := r.statuses()
	r.mu.Lock()
	err := r.configError
	telemetryError := r.telemetryError
	pollers := clone(r.cached.Config.Pollers)
	inspector := clone(r.inspector)
	r.mu.Unlock()
	byID := map[string]Health{}
	for _, h := range hs {
		byID[h.ID] = h
	}
	sources := []map[string]any{}
	started := false
	for _, p := range pollers {
		if p.Deleted {
			continue
		}
		name := p.Source
		if name == "deepsea" {
			name = "musher"
		}
		if name == "fronius" {
			name = "fusher"
		}
		h := byID[p.ID]
		live := inspector[p.ID]
		tick := map[string]any{"siteId": p.VendorSiteID, "name": name, "lastTickAt": h.CollectionAt, "lastError": h.CollectionError, "lastPushError": h.DeliveryError, "running": live.Running, "lastCount": live.Count}
		if h.DeliveryAt != nil || h.DeliveryError != "" {
			tick["pushOk"] = h.DeliveryError == ""
		}
		sources = append(sources, map[string]any{"siteId": p.VendorSiteID, "name": name, "intervalSec": float64(p.Settings.PushMS) / 1000, "activeIntervalSec": float64(p.Settings.ActivePushMS) / 1000, "tick": tick, "snapshot": live.Detail})
		if !p.Paused {
			started = true
		}
	}
	sp := r.spool.Stats()
	bb := r.blackbox.Stats()
	store := map[string]any{"dataDir": r.b.DataDir, "spool": map[string]any{"files": sp.Count, "bytes": sp.Bytes}, "blackbox": map[string]any{"enabled": true, "files": bb.Count, "bytes": bb.Bytes}}
	return map[string]any{"at": time.Now().UTC().Format(time.RFC3339Nano), "started": started, "sources": sources, "store": store, "mode": r.b.Mode, "pollers": hs, "configError": err, "telemetryError": telemetryError, "spool": sp, "blackbox": bb}
}

// Receiver retains a durable receipt independently of its bounded capture history.
func Receiver(dir, token string, budget int64) (http.Handler, error) {
	store, e := OpenStore(dir, budget, 64<<20)
	if e != nil {
		return nil, e
	}
	unlock, e := lockInstance(filepath.Join(dir, ".receiver.lock"))
	if e != nil {
		return nil, e
	}
	journal, e := openReceipts(dir)
	if e == nil {
		// Upgrade retained captures before any pruning can discard their acknowledgement.
		entries, err := os.ReadDir(dir)
		e = err
		for _, entry := range entries {
			if e != nil {
				break
			}
			name := entry.Name()
			if len(name) != 37 || !strings.HasSuffix(name, ".json") {
				continue
			}
			data, err := os.ReadFile(filepath.Join(dir, name))
			if err != nil {
				e = err
				break
			}
			info, err := entry.Info()
			if err != nil {
				e = err
				break
			}
			e = journal.append(strings.TrimSuffix(name, ".json"), sha256.Sum256(data), info.ModTime())
		}
	}
	unlock()
	if e != nil {
		return nil, e
	}

	var mu sync.Mutex
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !authorized(r, token) {
			w.WriteHeader(401)
			return
		}
		if r.Method == "GET" && r.URL.Path == "/export" {
			mu.Lock()
			defer mu.Unlock()
			unlock, err := lockInstance(filepath.Join(dir, ".receiver.lock"))
			if err != nil {
				w.WriteHeader(503)
				return
			}
			defer unlock()
			if err := journal.refresh(false); err != nil {
				w.WriteHeader(503)
				return
			}
			receiverExport(w, r, dir, journal)
			return
		}
		if r.Method != "POST" {
			w.WriteHeader(405)
			return
		}

		data, e := readLimited(r.Body, 2<<20)
		if e != nil {
			w.WriteHeader(413)
			return
		}
		var raw map[string]json.RawMessage
		if json.Unmarshal(data, &raw) != nil {
			w.WriteHeader(400)
			return
		}
		if _, ok := raw["apiKey"]; ok {
			w.WriteHeader(400)
			return
		}
		var b Batch
		if json.Unmarshal(data, &b) != nil || len(b.ID) != 32 || strings.Trim(b.ID, "0123456789abcdef") != "" || b.PollerID == "" || len(b.Readings) == 0 || b.MeasurementTime.IsZero() {
			w.WriteHeader(400)
			return
		}
		mu.Lock()
		defer mu.Unlock()
		unlock, e := lockInstance(filepath.Join(dir, ".receiver.lock"))
		if e != nil {
			w.WriteHeader(503)
			return
		}
		defer unlock()
		if e := journal.refresh(false); e != nil {
			w.WriteHeader(503)
			return
		}
		if old, ok := journal.entries[b.ID]; ok {
			if old.Hash != sha256.Sum256(data) {
				w.WriteHeader(409)
				return
			}
			_, err := os.Stat(filepath.Join(dir, b.ID+".json"))
			jsonResponse(w, 200, map[string]any{"id": b.ID, "durable": true, "duplicate": true, "captureRetained": err == nil})
			return
		}
		if journal.offset+receiptSize > journal.budget {
			jsonResponse(w, 503, map[string]string{"error": "receipt budget exhausted"})
			return
		}
		name := b.ID + ".json"
		path := filepath.Join(dir, name)
		old, e := os.ReadFile(path)
		if e == nil {
			if sha256.Sum256(old) != sha256.Sum256(data) {
				w.WriteHeader(409)
				return
			}
			if e := journal.append(b.ID, sha256.Sum256(data), time.Now()); e != nil {
				w.WriteHeader(503)
				return
			}
			jsonResponse(w, 200, map[string]any{"id": b.ID, "durable": true})
			return
		}
		if !os.IsNotExist(e) {
			w.WriteHeader(503)
			return
		}
		// Capture history has both size and three-day bounds, separate from pending delivery.
		entries, e := os.ReadDir(dir)
		if e != nil {
			w.WriteHeader(503)
			return
		}
		for _, f := range entries {
			if strings.HasSuffix(f.Name(), ".json") && f.Name() != "loss.json" {
				info, e := f.Info()
				if e == nil && time.Since(info.ModTime()) > 72*time.Hour {
					if e = store.Ack(f.Name()); e != nil {
						w.WriteHeader(503)
						return
					}
				}
			}
		}
		if e = store.Put(name, data, false); e != nil {
			w.WriteHeader(503)
			return
		}
		if e := journal.append(b.ID, sha256.Sum256(data), time.Now()); e != nil {
			w.WriteHeader(503)
			return
		}
		jsonResponse(w, 200, map[string]any{"id": b.ID, "durable": true})
	}), nil
}
