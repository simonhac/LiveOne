package gousher

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

func receiverExport(w http.ResponseWriter, r *http.Request, dir string, j *receiptJournal) {
	q := r.URL.Query()
	start, e1 := time.Parse(time.RFC3339Nano, q.Get("start"))
	end, e2 := time.Parse(time.RFC3339Nano, q.Get("end"))
	revision, e3 := strconv.Atoi(q.Get("revision"))
	asOf := time.Now()
	if raw := q.Get("asOf"); raw != "" {
		var e error
		asOf, e = time.Parse(time.RFC3339Nano, raw)
		if e != nil {
			w.WriteHeader(400)
			return
		}
	}
	if e1 != nil || e2 != nil || e3 != nil || revision < 1 || q.Get("pollerId") == "" || !end.After(start) || end.Sub(start) > time.Hour || asOf.After(time.Now().Add(time.Minute)) {
		w.WriteHeader(400)
		return
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		w.WriteHeader(503)
		return
	}
	batches := []Batch{}
	size := 0
	cursor := q.Get("cursor")
	next := ""
	last := cursor
	for _, entry := range entries {
		name := entry.Name()
		if len(name) != 37 || !strings.HasSuffix(name, ".json") || name <= cursor {
			continue
		}
		receipt, ok := j.entries[strings.TrimSuffix(name, ".json")]
		if !ok || receipt.At.After(asOf) {
			continue
		}
		data, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			w.WriteHeader(503)
			return
		}
		var b Batch
		if json.Unmarshal(data, &b) != nil {
			w.WriteHeader(503)
			return
		}
		if b.PollerID != q.Get("pollerId") || b.Revision != revision || b.MeasurementTime.Before(start) || !b.MeasurementTime.Before(end) {
			continue
		}
		if len(batches) >= 100 || (size+len(data) > 4<<20 && len(batches) > 0) {
			next = last
			break
		}
		batches = append(batches, b)
		size += len(data)
		last = name
	}
	jsonResponse(w, 200, map[string]any{"batches": batches, "nextCursor": next, "asOf": asOf.UTC(), "receiptCount": len(j.entries)})
}
