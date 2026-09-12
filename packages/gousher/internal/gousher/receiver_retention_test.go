package gousher

import (
	"crypto/sha256"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestReceiverReceiptsOutliveCaptureAndRestart(t *testing.T) {
	dir := t.TempDir()
	h, err := Receiver(dir, "secret", 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	batch := Batch{ID: strings.Repeat("a", 32), PollerID: "p", VendorSiteID: "site", Revision: 1, MeasurementTime: time.Now(), Readings: []Reading{{"value": 1}}}
	send := func(h http.Handler, b Batch) int {
		data, _ := json.Marshal(b)
		r := httptest.NewRequest("POST", "/", strings.NewReader(string(data)))
		r.Header.Set("Authorization", "Bearer secret")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w.Code
	}
	if send(h, batch) != 200 {
		t.Fatal("first delivery failed")
	}
	if err := os.Remove(filepath.Join(dir, batch.ID+".json")); err != nil {
		t.Fatal(err)
	}
	h, err = Receiver(dir, "secret", 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	changed := batch
	changed.Readings = []Reading{{"value": 2}}
	if got := send(h, changed); got != 409 {
		t.Errorf("expired ID accepted different bytes: HTTP %d", got)
	}
	if got := send(h, batch); got != 200 {
		t.Errorf("retry lost acknowledgement: HTTP %d", got)
	}
	if _, err := os.Stat(filepath.Join(dir, batch.ID+".json")); !os.IsNotExist(err) {
		t.Error("duplicate recaptured as a new delivery")
	}
}

func TestReceiptJournalFullAndTornTail(t *testing.T) {
	dir := t.TempDir()
	j, err := openReceipts(dir)
	if err != nil {
		t.Fatal(err)
	}
	j.budget = receiptSize
	hash := sha256.Sum256([]byte("data"))
	if err := j.append(strings.Repeat("a", 32), hash, time.Now()); err != nil {
		t.Fatal(err)
	}
	if err := j.append(strings.Repeat("b", 32), hash, time.Now()); err == nil {
		t.Fatal("full ledger silently evicted a receipt")
	}
	f, err := os.OpenFile(j.path, os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	f.Write([]byte{1, 2, 3})
	f.Close()
	reopened, err := openReceipts(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(reopened.entries) != 1 || reopened.offset != receiptSize {
		t.Fatal("torn tail recovery lost durable receipt")
	}
	data, err := os.ReadFile(j.path)
	if err != nil {
		t.Fatal(err)
	}
	data[20] ^= 1
	if err := os.WriteFile(j.path, data, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := openReceipts(dir); err == nil {
		t.Fatal("corrupt complete receipt was accepted")
	}
}

func TestReceiverExportRequiresAuthAndFiltersAssignment(t *testing.T) {
	dir := t.TempDir()
	h, err := Receiver(dir, "secret", 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Truncate(time.Hour)
	b := Batch{ID: strings.Repeat("d", 32), PollerID: "p", VendorSiteID: "site", Revision: 2, MeasurementTime: now, Readings: []Reading{{"value": 1}}}
	data, _ := json.Marshal(b)
	req := httptest.NewRequest("POST", "/", strings.NewReader(string(data)))
	req.Header.Set("Authorization", "Bearer secret")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatal(w.Code)
	}
	path := "/export?pollerId=p&revision=2&start=" + now.Format(time.RFC3339) + "&end=" + now.Add(time.Hour).Format(time.RFC3339)
	for _, token := range []string{"", "secret"} {
		req := httptest.NewRequest("GET", path, nil)
		req.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req)
		want := 200
		if token == "" {
			want = 401
		}
		if w.Code != want {
			t.Fatalf("export HTTP %d want %d", w.Code, want)
		}
		if token != "" {
			var body struct{ Batches []Batch }
			json.Unmarshal(w.Body.Bytes(), &body)
			if len(body.Batches) != 1 || body.Batches[0].ID != b.ID {
				t.Fatal(w.Body.String())
			}
		}
	}
	b.Readings = []Reading{{"value": 999}}
	corrupted, _ := json.Marshal(b)
	if err := os.WriteFile(filepath.Join(dir, b.ID+".json"), corrupted, 0600); err != nil {
		t.Fatal(err)
	}
	req = httptest.NewRequest("GET", path, nil)
	req.Header.Set("Authorization", "Bearer secret")
	w = httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != 503 {
		t.Fatalf("corrupted capture exported: HTTP %d", w.Code)
	}

}

func TestReceiverDoesNotRecreateMissingReceiptHistory(t *testing.T) {
	dir := t.TempDir()
	j, err := openReceipts(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(j.path); err != nil {
		t.Fatal(err)
	}
	if _, err := openReceipts(dir); err == nil {
		t.Fatal("missing receipt history silently reset deduplication")
	}
}
