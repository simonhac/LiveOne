package gousher

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestDecodeSentinels(t *testing.T) {
	cases := []struct {
		r    Register
		w    []uint16
		want any
	}{{Register{Words: 1, Scale: 1}, []uint16{65535}, nil}, {Register{Words: 1, Scale: 1, Signed: true}, []uint16{32760}, nil}, {Register{Words: 1, Scale: .1, Signed: true}, []uint16{65526}, float64(-1)}, {Register{Words: 2, Scale: 1}, []uint16{1, 2}, float64(65538)}, {Register{Words: 2, Scale: 1, Signed: true}, []uint16{0xffff, 0xffff}, float64(-1)}, {Register{Words: 2, Scale: 1}, []uint16{1}, nil}}
	for _, c := range cases {
		if got := Decode(c.r, c.w); got != c.want {
			t.Fatalf("got %v want %v", got, c.want)
		}
	}
}
func TestCloudNormalization(t *testing.T) {
	at := time.Date(2026, 9, 12, 0, 0, 0, 0, time.UTC)
	s, e := Normalize("sigenergy", map[string]any{"data": map[string]any{"pvPower": 1.2345, "batteryPower": -0.5, "buySellPower": 1.0, "evPower": 0.0, "acPower": 2.0, "soc": false}}, at)
	if e != nil {
		t.Fatal(e)
	}
	if s.Values["solarW"] != float64(1235) || s.Values["batteryW"] != float64(500) || s.Values["gridW"] != float64(-1000) || s.Values["evW"] != float64(2000) || s.Values["batterySOC"] != nil {
		t.Fatal(s.Values)
	}
	s, e = Normalize("selectronic", map[string]any{"items": map[string]any{"solarinverter_w": 1.4, "shunt_w": 1.4, "grid_w": -1.5, "solar_wh_total": 1.2345, "timestamp": float64(1000)}}, at)
	if e != nil {
		t.Fatal(e)
	}
	if s.Values["solarW"] != float64(3) || s.Values["gridW"] != float64(-1) || s.Values["solarKwhTotal"] != float64(1235) || !s.At.Equal(time.Unix(1000, 0)) {
		t.Fatal(s)
	}
	for _, r := range Readings("selectronic", s.Values) {
		if r["value"] == nil {
			t.Fatal("null reading escaped")
		}
	}
}
func TestStoreOverflowRecovery(t *testing.T) {
	dir := t.TempDir()
	s, e := OpenStore(dir, 600, 0)
	if e != nil {
		t.Fatal(e)
	}
	for i := 0; i < 3; i++ {
		b, _ := json.Marshal(Batch{ID: strings.Repeat(string(rune('a'+i)), 32), MeasurementTime: time.Unix(int64(i+1), 0), Readings: []Reading{{"value": strings.Repeat("x", 60)}}})
		if e = s.Put(string(rune('a'+i))+".json", b, true); e != nil {
			t.Fatal(e)
		}
	}
	stats := s.Stats()
	if stats.Bytes > 600 || stats.Lost.Count == 0 {
		t.Fatal(stats)
	}
	s, e = OpenStore(dir, 600, 0)
	if e != nil {
		t.Fatal(e)
	}
	if s.Stats().Lost.Count != stats.Lost.Count {
		t.Fatal("lost-count recovery failed")
	}
	name, _, e := s.Head()
	if e != nil {
		t.Fatal(e)
	}
	if name == "a.json" {
		t.Fatal("oldest was not evicted")
	}
	if e = s.Ack(name); e != nil {
		t.Fatal(e)
	}
}
func TestBlackboxHasNoAgeExpiry(t *testing.T) {
	s, e := OpenStore(t.TempDir(), 2000, 0)
	if e != nil {
		t.Fatal(e)
	}
	if e = s.Journal(map[string]any{"raw": "old diagnostic"}); e != nil {
		t.Fatal(e)
	}
	name, _, _ := s.Head()
	old := time.Now().AddDate(-5, 0, 0)
	os.Chtimes(filepath.Join(s.Dir, name), old, old)
	s, e = OpenStore(s.Dir, 2000, 0)
	if e != nil || s.Stats().Count != 1 {
		t.Fatal("aged diagnostic disappeared")
	}
	for i := 0; i < 40; i++ {
		if e = s.Journal(map[string]any{"raw": strings.Repeat("x", i+1)}); e != nil {
			t.Fatal(e)
		}
	}
	if s.Stats().Bytes > 2000 {
		t.Fatal("blackbox budget exceeded")
	}
}
func TestCredentialEncryption(t *testing.T) {
	key := bytes.Repeat([]byte{42}, 32)
	secret := []byte(`{"password":"not-in-journals"}`)
	b, e := seal(key, secret)
	if e != nil {
		t.Fatal(e)
	}
	if bytes.Contains(b, secret) {
		t.Fatal("plaintext cache")
	}
	got, e := unseal(key, b)
	if e != nil || !bytes.Equal(got, secret) {
		t.Fatal(e)
	}
	b[len(b)-1] ^= 1
	if _, e = unseal(key, b); e == nil {
		t.Fatal("tampering accepted")
	}
	if _, e = unseal(bytes.Repeat([]byte{1}, 32), b); e == nil {
		t.Fatal("wrong key accepted")
	}
}
func TestModbusNeverWritesInTrial(t *testing.T) {
	for _, mode := range []string{"shadow", "replay"} {
		m := NewModbus("127.0.0.1", 1, 10, mode)
		if e := m.WriteControl(context.Background(), 32); e == nil || !strings.Contains(e.Error(), "prohibited") {
			t.Fatal("unsafe write")
		}
	}
}
func TestModbusMalformedResponseAndSocketRecovery(t *testing.T) {
	ln, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	defer ln.Close()
	go func() {
		for {
			c, e := ln.Accept()
			if e != nil {
				return
			}
			go func() {
				defer c.Close()
				b := make([]byte, 12)
				io.ReadFull(c, b)
				c.Write([]byte{0, 99, 0, 0, 0, 3, 10, 3, 0})
			}()
		}
	}()
	a := ln.Addr().(*net.TCPAddr)
	m := NewModbus("127.0.0.1", a.Port, 10, "shadow")
	defer m.Close()
	for i := 0; i < 2; i++ {
		if _, e = m.Read(context.Background(), 1024, 1); e == nil {
			t.Fatal("invalid response accepted")
		}
	}
}

type simulator struct {
	mu                  sync.Mutex
	starts, stops       int
	failStart, failStop bool
}

func (s *simulator) Preflight(context.Context) (Ownership, error) {
	return Ownership{Mode: 1, TelemetryStart: true, TelemetryCancel: true}, nil
}
func (s *simulator) Start(context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.starts++
	if s.failStart {
		return errors.New("lost start ack")
	}
	return nil
}
func (s *simulator) Stop(context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.stops++
	if s.failStop {
		return errors.New("lost stop ack")
	}
	return nil
}
func TestAmbiguousStartDeadlineSurvivesRestart(t *testing.T) {
	target := &simulator{failStart: true}
	path := filepath.Join(t.TempDir(), "run.json")
	s, e := OpenSupervisor(target, path, 600)
	if e != nil {
		t.Fatal(e)
	}
	now := time.Now()
	if e = s.Request(context.Background(), 60, false, now); e == nil {
		t.Fatal("expected ambiguous start")
	}
	s, e = OpenSupervisor(target, path, 600)
	if e != nil || !s.Status().Latched {
		t.Fatal("deadline lost")
	}
	target.failStop = true
	if e = s.Reconcile(context.Background(), now.Add(time.Minute)); e == nil || !s.Status().Latched {
		t.Fatal("failed stop disarmed deadline")
	}
	target.failStop = false
	if e = s.Reconcile(context.Background(), now.Add(time.Minute)); e != nil || s.Status().Latched {
		t.Fatal("retry did not release")
	}
}
func TestControlPersistsBeforeStart(t *testing.T) {
	target := &simulator{}
	dir := t.TempDir()
	s, e := OpenSupervisor(target, filepath.Join(dir, "run"), 600)
	if e != nil {
		t.Fatal(e)
	}
	os.Mkdir(s.path, 0700)
	if e = s.Request(context.Background(), 60, false, time.Now()); e == nil {
		t.Fatal("expected persistence failure")
	}
	if target.starts != 0 {
		t.Fatal("started before durable deadline")
	}
}
func TestReceiverDurableDedupAndAuth(t *testing.T) {
	dir := t.TempDir()
	h, e := Receiver(dir, "secret", 128<<20)
	if e != nil {
		t.Fatal(e)
	}
	b, _ := json.Marshal(Batch{ID: strings.Repeat("a", 32), PollerID: "poller", MeasurementTime: time.Now(), Readings: []Reading{{"value": 1}}})
	send := func(h http.Handler, token string, b []byte) int {
		req := httptest.NewRequest("POST", "/", bytes.NewReader(b))
		req.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req)
		return w.Code
	}
	if send(h, "wrong", b) != 401 {
		t.Fatal("auth bypass")
	}
	if send(h, "secret", b) != 200 {
		t.Fatal("delivery failed")
	}
	h, e = Receiver(dir, "secret", 128<<20)
	if e != nil {
		t.Fatal(e)
	}
	if send(h, "secret", b) != 200 {
		t.Fatal("restart dedup failed")
	}
	var altered Batch
	json.Unmarshal(b, &altered)
	altered.Readings = []Reading{{"value": 2}}
	other, _ := json.Marshal(altered)
	if send(h, "secret", other) != 409 {
		t.Fatal("ID conflict accepted")
	}
	es, _ := os.ReadDir(dir)
	if len(es) != 1 {
		t.Fatal("duplicate capture")
	}
}
func TestIntegralAndHarvestCarry(t *testing.T) {
	p := Poller{Settings: Settings{Inverters: []Inverter{{Host: "master", Master: true, Battery: true}, {Host: "slave"}}}}
	f := NewFronius(p)
	at := time.Unix(0, 0).UTC()
	frame := func(power float64) map[string]any {
		return map[string]any{"Body": map[string]any{"Data": map[string]any{"Site": map[string]any{"P_PV": power, "P_Grid": 0.0, "P_Akku": 0.0}}}}
	}
	for i := 0; i <= 120; i++ {
		now := at.Add(time.Duration(i) * time.Second)
		f.inv[0].ingest(frame(120), now)
		f.inv[1].ingest(frame(60), now)
		f.latest = f.values()
		if i == 60 {
			if _, ok := f.Harvest(now); ok {
				t.Fatal("first harvest must be baseline")
			}
		}
	}
	v, ok := f.Harvest(at.Add(120 * time.Second))
	if !ok || v["solarWhInterval"] != float64(3) || v["solarW"] != float64(180) {
		t.Fatal(v)
	}
	if v["batteryInWhInterval"] != float64(0) {
		t.Fatal("zero energy omitted")
	}
}
func TestReplayFixtures(t *testing.T) {
	files, e := filepath.Glob("testdata/*.jsonl")
	if e != nil || len(files) < 4 {
		t.Fatal("four vendor fixture sets required")
	}
	for _, name := range files {
		t.Run(name, func(t *testing.T) {
			f, e := os.Open(name)
			if e != nil {
				t.Fatal(e)
			}
			defer f.Close()
			r, e := Replay(f)
			if e != nil || r.Mismatches != 0 {
				t.Fatalf("%+v %v", r, e)
			}
		})
	}
}
func TestInstanceLock(t *testing.T) {
	path := filepath.Join(t.TempDir(), "lock")
	release, e := lockInstance(path)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = lockInstance(path); e == nil {
		t.Fatal("overlapping owner")
	}
	release()
	release, e = lockInstance(path)
	if e != nil {
		t.Fatal(e)
	}
	release()
}
func TestRedaction(t *testing.T) {
	b, _ := json.Marshal(redact(map[string]any{"nested": map[string]any{"password": "danger", "access_token": "danger", "value": 1.0}}))
	if bytes.Contains(b, []byte("danger")) {
		t.Fatal("credential escaped")
	}
}

type blockingSource struct {
	entered chan struct{}
	exited  chan struct{}
	once    sync.Once
	values  map[string]any
}

func (s *blockingSource) Sample(ctx context.Context, at time.Time) (Sample, error) {
	s.once.Do(func() { close(s.entered) })
	<-ctx.Done()
	close(s.exited)
	return Sample{}, ctx.Err()
}
func (s *blockingSource) Harvest(time.Time) (map[string]any, bool) { return s.values, true }
func (s *blockingSource) Close() error                             { return nil }
func testRuntime(t *testing.T) *Runtime {
	t.Helper()
	dir := t.TempDir()
	bb, e := OpenStore(filepath.Join(dir, "blackbox"), 1<<20, 0)
	if e != nil {
		t.Fatal(e)
	}
	sp, e := OpenStore(filepath.Join(dir, "spool"), 1<<20, 0)
	if e != nil {
		t.Fatal(e)
	}
	return &Runtime{b: Bootstrap{Mode: "shadow", DataDir: dir, ReceiverURL: "http://localhost:9001/capture", AllowedHosts: []string{"master"}}, key: bytes.Repeat([]byte{1}, 32), generations: map[string]*generation{}, health: map[string]Health{}, spool: sp, blackbox: bb, cached: cache{Credentials: map[string]map[string]string{}}}
}
func TestReaderReplacementWaitsAndPreservesCadenceState(t *testing.T) {
	r := testRuntime(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	first := &blockingSource{entered: make(chan struct{}), exited: make(chan struct{})}
	r.factory = func(Poller, map[string]string, string) (Source, error) { return first, nil }
	p := Poller{ID: "p", CollectorID: "c", DeviceID: "d", VendorSiteID: "site", Source: "fronius", Revision: 1, Settings: Settings{PollMS: 2000, PushMS: 60000, Inverters: []Inverter{{Host: "master", Master: true}}}}
	c := Config{CollectorID: "c", Pollers: []Poller{p}}
	if e := r.apply(ctx, c, nil); e != nil {
		t.Fatal(e)
	}
	<-first.entered
	c.Pollers[0].Revision = 2
	c.Pollers[0].Paused = true
	c.Pollers[0].Settings.PushMS = 120000
	if e := r.apply(ctx, c, nil); e != nil {
		t.Fatal(e)
	}
	select {
	case <-first.exited:
	default:
		t.Fatal("old reader still running after acknowledgement")
	}
	if r.generations["p"].source != first {
		t.Fatal("cadence-only change reset integration state")
	}
	if r.health["p"].AppliedRevision != 2 || !r.health["p"].Stopped {
		t.Fatal(r.health["p"])
	}
	r.generations["p"].cancel()
}
func TestInvalidConfigKeepsPreviousGenerationAndCache(t *testing.T) {
	r := testRuntime(t)
	p := Poller{ID: "p", CollectorID: "c", DeviceID: "d", VendorSiteID: "site", Source: "deepsea", Revision: 1, Paused: true, Settings: Settings{Host: "master", Port: 502, UnitID: 10, PollMS: 1000, PushMS: 1000}}
	c := Config{CollectorID: "c", Pollers: []Poller{p}}
	if e := r.apply(context.Background(), c, nil); e != nil {
		t.Fatal(e)
	}
	old := r.generations["p"]
	disk, _ := os.ReadFile(filepath.Join(r.b.DataDir, "config.enc"))
	c.Pollers[0].Revision = 2
	c.Pollers[0].Settings.Host = "not-allowed"
	if e := r.apply(context.Background(), c, nil); e == nil {
		t.Fatal("unsafe host accepted")
	}
	after, _ := os.ReadFile(filepath.Join(r.b.DataDir, "config.enc"))
	if !bytes.Equal(disk, after) || r.generations["p"] != old {
		t.Fatal("failed update replaced previous config")
	}
	old.cancel()
	old.source.Close()
}
func TestAtomicTempRecovery(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, ".pending-crash"), []byte("partial"), 0600)
	s, e := OpenStore(dir, 1000, 0)
	if e != nil {
		t.Fatal(e)
	}
	if s.Stats().Count != 0 {
		t.Fatal("partial record replayed")
	}
	if _, e = os.Stat(filepath.Join(dir, ".pending-crash")); !os.IsNotExist(e) {
		t.Fatal("temporary file not reclaimed")
	}
}
func TestReplayDeniesDeviceReads(t *testing.T) {
	m := NewModbus("localhost", 1, 10, "replay")
	if _, e := m.Read(context.Background(), 0, 1); e == nil || !strings.Contains(e.Error(), "replay") {
		t.Fatal("replay contacted device")
	}
}

func TestManagedDeletionWaitsForArmedDeadline(t *testing.T) {
	r := testRuntime(t)
	p := Poller{ID: "p", CollectorID: "c", DeviceID: "d", VendorSiteID: "site", Source: "deepsea", Revision: 1, Paused: true, Settings: Settings{Host: "master", Port: 502, UnitID: 10, PollMS: 1000, PushMS: 1000}}
	c := Config{CollectorID: "c", Pollers: []Poller{p}}
	if e := r.apply(context.Background(), c, nil); e != nil {
		t.Fatal(e)
	}
	defer r.generations["p"].source.Close()
	deadline := time.Now().Add(time.Minute)
	state, _ := json.Marshal(ControlStatus{Latched: true, StopAt: &deadline})
	if e := AtomicWrite(filepath.Join(r.b.DataDir, "controls", "p.json"), state); e != nil {
		t.Fatal(e)
	}
	before, _ := os.ReadFile(filepath.Join(r.b.DataDir, "config.enc"))
	c.Pollers[0].Deleted = true
	c.Pollers[0].Revision = 2
	if e := r.apply(context.Background(), c, nil); e == nil {
		t.Fatal("deletion acknowledged while a generator deadline is armed")
	}
	after, _ := os.ReadFile(filepath.Join(r.b.DataDir, "config.enc"))
	if !bytes.Equal(before, after) {
		t.Fatal("pending deletion replaced last applied configuration")
	}
	if r.health["p"].AppliedRevision != 1 {
		t.Fatal("applied revision advanced before supervision completed")
	}
}

func TestSameRevisionCannotChangeSettings(t *testing.T) {
	r := testRuntime(t)
	p := Poller{ID: "p", CollectorID: "c", DeviceID: "d", VendorSiteID: "site", Source: "deepsea", Revision: 1, Paused: true, Settings: Settings{Host: "master", Port: 502, UnitID: 10, PollMS: 1000, PushMS: 1000}}
	c := Config{CollectorID: "c", Pollers: []Poller{p}}
	if e := r.apply(context.Background(), c, nil); e != nil {
		t.Fatal(e)
	}
	defer r.generations["p"].source.Close()
	c.Pollers[0].Settings.PollMS = 2000
	if e := r.apply(context.Background(), c, nil); e == nil {
		t.Fatal("changed settings accepted without a new revision")
	}
	if r.generations["p"].p.Settings.PollMS != 1000 {
		t.Fatal("conflicting settings replaced the applied reader")
	}
}

func TestMalformedSpoolDoesNotBlockDelivery(t *testing.T) {
	r := testRuntime(t)
	if e := r.spool.Put("bad.json", []byte("{truncated"), false); e != nil {
		t.Fatal(e)
	}
	b := Batch{ID: strings.Repeat("c", 32), PollerID: "p", VendorSiteID: "site", MeasurementTime: time.Now(), Readings: []Reading{{"value": 1.0}}}
	data, _ := json.Marshal(b)
	if e := r.spool.Put("good.json", data, false); e != nil {
		t.Fatal(e)
	}
	delivered := make(chan struct{}, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		jsonResponse(w, 200, map[string]any{"id": b.ID, "durable": true})
		delivered <- struct{}{}
	}))
	defer server.Close()
	r.b.ReceiverURL = server.URL
	r.client = server.Client()
	r.receiverToken = "trial-only"
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() { defer close(done); r.delivery(ctx) }()
	select {
	case <-delivered:
	case <-time.After(time.Second):
		cancel()
		<-done
		t.Fatal("malformed spool record stranded a valid delivery")
	}
	cancel()
	<-done
	if r.spool.Stats().Lost.Count != 1 {
		t.Fatal("corrupt undelivered batch was not counted as lost")
	}
}

func TestIndependentComparisonReportsUnmatchedSamples(t *testing.T) {
	at := time.Date(2026, 9, 12, 0, 0, 0, 0, time.UTC)
	reading := Reading{"physicalPathTail": "solar_w", "metricType": "power", "metricUnit": "W", "value": float64(100)}
	reference := []Batch{{VendorSiteID: "site", MeasurementTime: at, Readings: []Reading{reading}}, {VendorSiteID: "site", MeasurementTime: at.Add(time.Minute), Readings: []Reading{reading}}}
	actual := []Batch{{VendorSiteID: "site", MeasurementTime: at.Add(time.Second), Readings: []Reading{reading}}, {VendorSiteID: "other", MeasurementTime: at, Readings: []Reading{reading}}}
	report := CompareIndependent(reference, actual, 2*time.Second)
	if report.Matched != 1 || report.UnmatchedReference != 1 || report.UnmatchedActual != 1 || report.Mismatches != 0 {
		t.Fatalf("incorrect sample matching: %+v", report)
	}
	// One actual observation cannot satisfy two independent reference observations.
	reference = append(reference, reference[0])
	report = CompareIndependent(reference, actual, 2*time.Second)
	if report.Matched != 1 || report.UnmatchedReference != 2 {
		t.Fatal("actual observation matched more than once")
	}
}

func TestTrialThresholdRequiresTwoConsecutiveWindows(t *testing.T) {
	monitor := TrialMonitor{}
	baseline := WindowMetrics{FailureRate: 0.01, P95ReadMS: 100}
	degraded := WindowMetrics{FailureRate: 0.021, P95ReadMS: 100}
	if monitor.Observe(baseline, degraded) {
		t.Fatal("stopped after only one bad window")
	}
	if !monitor.Observe(baseline, degraded) {
		t.Fatal("did not stop after two bad windows")
	}
	monitor = TrialMonitor{}
	monitor.Observe(baseline, degraded)
	monitor.Observe(baseline, baseline)
	if monitor.Observe(baseline, degraded) {
		t.Fatal("healthy window did not reset consecutive count")
	}
	if !monitor.Observe(baseline, WindowMetrics{FailureRate: 0.01, P95ReadMS: 200}) {
		t.Fatal("latency doubling did not trip the second degraded window")
	}
}

func TestDailySummaryRetentionAndFixtureBudget(t *testing.T) {
	dir := t.TempDir()
	now := time.Date(2026, 9, 12, 0, 0, 0, 0, time.UTC)
	if e := SaveDailySummary(dir, map[string]any{"matched": 3}, now.AddDate(0, 0, -46)); e != nil {
		t.Fatal(e)
	}
	if e := SaveDailySummary(dir, map[string]any{"matched": 4}, now); e != nil {
		t.Fatal(e)
	}
	entries, e := os.ReadDir(filepath.Join(dir, "summaries"))
	if e != nil {
		t.Fatal(e)
	}
	count := 0
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".json") {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("expected one retained daily summary, got %d", count)
	}
	fixture := bytes.Repeat([]byte("x"), 9<<20)
	if e := RetainFixture(dir, "first.jsonl", fixture); e != nil {
		t.Fatal(e)
	}
	if e := RetainFixture(dir, "second.jsonl", fixture); e == nil {
		t.Fatal("regression fixture budget exceeded")
	}
	if _, e = os.Stat(filepath.Join(dir, "fixtures", "first.jsonl")); e != nil {
		t.Fatal("selected fixture was evicted before review")
	}
}

func TestInspectorPreservesUsherEnvelope(t *testing.T) {
	r := testRuntime(t)
	r.cached.Config.Pollers = []Poller{{ID: "p", VendorSiteID: "site", Source: "deepsea", Settings: Settings{PushMS: 60000, ActivePushMS: 15000}}}
	view := r.snapshot()
	if _, ok := view["at"].(string); !ok {
		t.Fatal("inspector is missing Usher at timestamp")
	}
	sources, ok := view["sources"].([]map[string]any)
	if !ok || len(sources) != 1 {
		t.Fatal("inspector is missing Usher source list")
	}
	if sources[0]["siteId"] != "site" || sources[0]["name"] != "musher" || sources[0]["intervalSec"] != float64(60) {
		t.Fatal(sources)
	}
	if _, ok := view["store"].(map[string]any); !ok {
		t.Fatal("inspector is missing Usher store envelope")
	}
}
func TestCollectionFailureCannotEraseDeliveryFailure(t *testing.T) {
	r := testRuntime(t)
	r.setError("p", "delivery-failed")
	r.setError("p", "collection-failed")
	data, _ := json.Marshal(r.statuses())
	var health []map[string]any
	json.Unmarshal(data, &health)
	if health[0]["collectionError"] != "collection-failed" || health[0]["deliveryError"] != "delivery-failed" {
		t.Fatal("collection error erased outstanding delivery failure")
	}
}

func TestDeepSeaReconnectsBetweenPolls(t *testing.T) {
	listener, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	defer listener.Close()
	go func() {
		for {
			conn, e := listener.Accept()
			if e != nil {
				return
			}
			go func() {
				defer conn.Close()
				for {
					request := make([]byte, 12)
					if _, e := io.ReadFull(conn, request); e != nil {
						return
					}
					count := int(request[10])<<8 | int(request[11])
					response := make([]byte, 9+count*2)
					copy(response[:7], request[:7])
					response[4] = byte((count*2 + 3) >> 8)
					response[5] = byte(count*2 + 3)
					response[7] = 3
					response[8] = byte(count * 2)
					if _, e := conn.Write(response); e != nil {
						return
					}
				}
			}()
		}
	}()
	source := &DeepSea{transport: NewModbus("127.0.0.1", listener.Addr().(*net.TCPAddr).Port, 10, "shadow")}
	defer source.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if _, e = source.Sample(ctx, time.Now()); e != nil {
		t.Fatal(e)
	}
	if source.transport.conn != nil {
		t.Fatal("Deep Sea kept its connection open between polls, unlike TypeScript Usher")
	}
}

func TestUnattributedStorageFailureIsCollectorScoped(t *testing.T) {
	r := testRuntime(t)
	r.setError("", "storage-failed")
	if len(r.statuses()) != 0 {
		t.Fatal("unattributed storage error created an invalid poller status")
	}
	if r.configError != "storage-failed" {
		t.Fatal("collector storage error was hidden")
	}
}

func TestSupervisorDistinguishesReleasedLatchFromStoppedEngine(t *testing.T) {
	target := &simulator{}
	s, e := OpenSupervisor(target, filepath.Join(t.TempDir(), "run.json"), 600)
	if e != nil {
		t.Fatal(e)
	}
	now := time.Now()
	s.Observe(Ownership{Mode: 1, Running: true, RemoteStartInput: "closed"}, now)
	if s.View(now)["state"] != "running:sp-pro" {
		t.Fatal("external run misattributed to hub")
	}
	if e = s.Request(context.Background(), 60, true, now); e != nil {
		t.Fatal(e)
	}
	if s.View(now)["state"] != "running:hub" {
		t.Fatal("hub latch not reflected in state")
	}
	if e = s.Request(context.Background(), 0, false, now); e != nil {
		t.Fatal(e)
	}
	if s.View(now)["state"] != "stopping" {
		t.Fatal("latch release reported as engine stopped")
	}
	s.Observe(Ownership{Mode: 1, Running: true, RemoteStartInput: "closed"}, now.Add(6*time.Minute))
	if s.View(now.Add(6 * time.Minute))["state"] != "latch-released-still-running" {
		t.Fatal("prolonged independent running was hidden")
	}
	s.Observe(Ownership{Mode: 1, Running: false, RemoteStartInput: "open"}, now.Add(7*time.Minute))
	if s.View(now.Add(7 * time.Minute))["state"] != "idle" {
		t.Fatal("confirmed stop not reflected")
	}
}
func TestSupervisorSyntheticValuesKeepRemainingMinuteNonzero(t *testing.T) {
	s, e := OpenSupervisor(&simulator{}, filepath.Join(t.TempDir(), "run.json"), 600)
	if e != nil {
		t.Fatal(e)
	}
	now := time.Now()
	if e = s.Request(context.Background(), 20, false, now); e != nil {
		t.Fatal(e)
	}
	v := s.SyntheticValues(now)
	if v["controlRunActive"] != 1 || v["controlRunRequestMin"] != 1 {
		t.Fatal("armed short deadline appeared stopped")
	}
	if !s.InTransition(now) {
		t.Fatal("start did not open fast transition cadence")
	}
	if s.InTransition(now.Add(4 * time.Minute)) {
		t.Fatal("transition cadence did not expire")
	}
}

func TestSimulatorControlAPIUsesUsherRunAndProbeContract(t *testing.T) {
	target := &simulator{}
	s, e := OpenSupervisor(target, filepath.Join(t.TempDir(), "run.json"), 600)
	if e != nil {
		t.Fatal(e)
	}
	handler := s.SimulatorHandler("site", "simulator-secret")
	send := func(path, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest("POST", "/api/usher/control/site/"+path, strings.NewReader(body))
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)
		return w
	}
	if w := send("run", `{"passkey":"wrong","runtimeSec":60}`); w.Code != 401 {
		t.Fatal("control API did not authenticate")
	}
	if target.starts != 0 {
		t.Fatal("unauthenticated request reached simulator")
	}
	w := send("probe", `{"passkey":"simulator-secret"}`)
	if w.Code != 200 {
		t.Fatalf("probe failed: %s", w.Body.String())
	}
	var probe map[string]any
	json.Unmarshal(w.Body.Bytes(), &probe)
	if probe["ok"] != true || probe["wouldStart"] != true || probe["maxRuntimeSec"] != float64(600) {
		t.Fatal(probe)
	}
	w = send("run", `{"passkey":"simulator-secret","runtimeSec":60}`)
	if w.Code != 200 {
		t.Fatalf("run failed: %s", w.Body.String())
	}
	var result map[string]any
	json.Unmarshal(w.Body.Bytes(), &result)
	if result["action"] != "started" || obj(result["status"])["latched"] != true {
		t.Fatal(result)
	}
	w = send("run", `{"passkey":"simulator-secret","runtimeSec":0}`)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	json.Unmarshal(w.Body.Bytes(), &result)
	if result["action"] != "released" || result["released"] != true {
		t.Fatal(result)
	}
}

func TestInspectorMetricsAndStaleReaderHealth(t *testing.T) {
	r := testRuntime(t)
	r.inspectorToken = "inspect"
	old := time.Now().Add(-5 * time.Minute)
	r.health["p"] = Health{ID: "p", CollectionAt: &old}
	r.cached.Config.Pollers = []Poller{{ID: "p", Settings: Settings{PollMS: 1000}}}
	data, _ := json.Marshal(r.statuses())
	var status []map[string]any
	json.Unmarshal(data, &status)
	if status[0]["collectionStale"] != true {
		t.Fatal("stale collection was reported healthy")
	}
	request := httptest.NewRequest("GET", "/metrics", nil)
	request.Header.Set("Authorization", "Bearer inspect")
	w := httptest.NewRecorder()
	r.Handler().ServeHTTP(w, request)
	if w.Code != 200 || !strings.Contains(w.Body.String(), "gousher_spool_bytes") || !strings.Contains(w.Body.String(), "gousher_collection_last_success_seconds") {
		t.Fatalf("missing collector metrics: %d %s", w.Code, w.Body.String())
	}
	request = httptest.NewRequest("GET", "/metrics", nil)
	w = httptest.NewRecorder()
	r.Handler().ServeHTTP(w, request)
	if w.Code != 401 {
		t.Fatal("private metrics exposed without auth")
	}
}

func TestReplayConnectionChangeStartsNewFroniusBaseline(t *testing.T) {
	at := time.Date(2026, 9, 12, 0, 0, 0, 0, time.UTC)
	var input bytes.Buffer
	frame := map[string]any{"Body": map[string]any{"Data": map[string]any{"Site": map[string]any{"P_PV": 100.0}}}}
	for i := 0; i < 3; i++ {
		host := "old"
		revision := 1
		if i == 2 {
			host = "new"
			revision = 2
		}
		f := Fixture{Source: "fronius", PollerID: "p", Revision: revision, At: at.Add(time.Duration(i) * time.Minute), Harvest: true, Raw: map[string]any{host: frame}, Settings: Settings{PollMS: 2000, PushMS: 60000, Inverters: []Inverter{{Host: host, Master: true}}}, Expected: []Reading{}}
		json.NewEncoder(&input).Encode(f)
	}
	report, e := Replay(&input)
	if e != nil {
		t.Fatal(e)
	}
	if report.Mismatches != 0 {
		t.Fatal("replay retained the previous connection's integration baseline")
	}
}

func TestSSEUsesUsherDefaultMessageEvents(t *testing.T) {
	r := testRuntime(t)
	r.inspectorToken = "inspect"
	server := httptest.NewServer(r.Handler())
	defer server.Close()
	request, _ := http.NewRequest("GET", server.URL+"/api/usher/stream", nil)
	request.Header.Set("Authorization", "Bearer inspect")
	response, e := server.Client().Do(request)
	if e != nil {
		t.Fatal(e)
	}
	defer response.Body.Close()
	first, e := bufio.NewReader(response.Body).ReadString('\n')
	if e != nil {
		t.Fatal(e)
	}
	if !strings.HasPrefix(first, "data: ") {
		t.Fatalf("SSE broke existing onmessage clients: %q", first)
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func sigenFixtureClient() (*Cloud, *[]url.Values) {
	forms := []url.Values{}
	client := NewCloud(Poller{Source: "sigenergy", VendorSiteID: "site", Settings: Settings{Region: "aus", AuthMode: "legacy"}}, map[string]string{"username": "user", "password": "secret"})
	client.client = &http.Client{Timeout: time.Second, Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		body := `{"data":{"pvPower":1}}`
		if r.Method == "POST" {
			data, _ := io.ReadAll(r.Body)
			form, _ := url.ParseQuery(string(data))
			forms = append(forms, form)
			body = `{"access_token":"access","refresh_token":"refresh","expires_in":3600}`
		}
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(body))}, nil
	})}
	return client, &forms
}
func TestSigenUsesExistingStableDeviceIdentity(t *testing.T) {
	client, forms := sigenFixtureClient()
	if _, e := client.Sample(context.Background(), time.Now()); e != nil {
		t.Fatal(e)
	}
	sum := sha256.Sum256([]byte("liveone:user:aus"))
	if (*forms)[0].Get("userDeviceId") != hex.EncodeToString(sum[:16]) {
		t.Fatal("Go authentication changed the existing TypeScript device identity")
	}
}
func TestSigenRefreshesInsteadOfReloggingIn(t *testing.T) {
	client, forms := sigenFixtureClient()
	if _, e := client.Sample(context.Background(), time.Now()); e != nil {
		t.Fatal(e)
	}
	client.expires = time.Now().Add(-time.Second)
	if _, e := client.Sample(context.Background(), time.Now()); e != nil {
		t.Fatal(e)
	}
	if len(*forms) != 2 || (*forms)[1].Get("grant_type") != "refresh_token" || (*forms)[1].Get("refresh_token") != "refresh" {
		t.Fatal("expired access token triggered a new password login instead of refresh")
	}
}

func TestSigenDefaultAuthDoesNotFallBackToAnotherSession(t *testing.T) {
	client, _ := sigenFixtureClient()
	client.p.Settings.AuthMode = ""
	calls := 0
	client.client.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		calls++
		return &http.Response{StatusCode: 401, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{"error":"unauthorized"}`))}, nil
	})
	if _, e := client.Sample(context.Background(), time.Now()); e == nil {
		t.Fatal("rejected login succeeded")
	}
	if calls != 1 {
		t.Fatalf("default auth made %d login attempts; legacy must not fall back without explicit auto mode", calls)
	}
}

type inspectorSource struct{}

func (*inspectorSource) Sample(_ context.Context, at time.Time) (Sample, error) {
	return Sample{At: at, Active: true, Values: map[string]any{"engineRpm": float64(1500), "diagnosticOnly": float64(42)}, Raw: map[string]any{}}, nil
}
func (*inspectorSource) Harvest(time.Time) (map[string]any, bool) {
	return map[string]any{"engineRpm": float64(1500)}, true
}
func (*inspectorSource) Close() error { return nil }
func TestInspectorShowsLiveRegistersAndRunningState(t *testing.T) {
	r := testRuntime(t)
	p := Poller{ID: "p", Source: "deepsea", VendorSiteID: "site", Settings: Settings{PollMS: 60000, PushMS: 60000}}
	r.cached.Config.Pollers = []Poller{p}
	ctx, cancel := context.WithCancel(context.Background())
	g := &generation{p: p, source: &inspectorSource{}, done: make(chan struct{})}
	go r.collect(ctx, g)
	defer func() { cancel(); <-g.done }()
	deadline := time.Now().Add(time.Second)
	for {
		r.mu.Lock()
		collected := r.health[p.ID].CollectionAt != nil
		r.mu.Unlock()
		if collected {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("sample never completed")
		}
		time.Sleep(time.Millisecond)
	}
	source := r.snapshot()["sources"].([]map[string]any)[0]
	detail, ok := source["snapshot"].(map[string]any)
	if !ok {
		t.Fatal("SSE source has no live register snapshot")
	}
	if obj(detail["values"])["diagnosticOnly"] != float64(42) {
		t.Fatal("inspector lost non-manifest diagnostic registers")
	}
	if source["tick"].(map[string]any)["running"] != true {
		t.Fatal("inspector lost generator running state")
	}
}

func TestFroniusInspectorShowsPowerAndBoundedHarvestHistory(t *testing.T) {
	f := NewFronius(Poller{Settings: Settings{Inverters: []Inverter{{Host: "master", Master: true, Battery: true}}}})
	at := time.Date(2026, 9, 12, 0, 0, 0, 0, time.UTC)
	raw := map[string]any{"Body": map[string]any{"Data": map[string]any{"Site": map[string]any{"P_PV": 120.0, "P_Grid": 30.0, "P_Akku": -10.0}, "Inverters": map[string]any{"1": map[string]any{"SOC": 55.0}}}}}
	for i := 0; i < 24; i++ {
		now := at.Add(time.Duration(i) * time.Minute)
		if e := f.inv[0].ingest(raw, now); e != nil {
			t.Fatal(e)
		}
		f.latest = f.values()
		f.Harvest(now)
	}
	provider, ok := any(f).(interface {
		Inspector(time.Time) map[string]any
	})
	if !ok {
		t.Fatal("Fronius does not supply the existing inspector detail")
	}
	detail := provider.Inspector(at.Add(23 * time.Minute))
	site := obj(obj(detail["latestSiteMetrics"])["site"])
	if obj(site["solar"])["powerW"] != float64(120) || obj(site["battery"])["soc"] != float64(55) || obj(site["load"])["powerW"] != float64(140) {
		t.Fatal(site)
	}
	devices := obj(detail["site"])["devices"].([]map[string]any)
	if len(devices) != 1 || devices[0]["ip"] != "master" || devices[0]["isMaster"] != true {
		t.Fatal(devices)
	}
	history := detail["minutely"].([]map[string]any)
	if len(history) != 20 || history[19]["solarW"] != float64(120) || history[19]["timestamp"] != at.Add(23*time.Minute).Format(time.RFC3339Nano) {
		t.Fatal(history)
	}
}

func TestTrialWindowsStopReaderOnceAndSurviveRestart(t *testing.T) {
	r := testRuntime(t)
	r.inspectorToken = "monitor"
	first := &blockingSource{entered: make(chan struct{}), exited: make(chan struct{})}
	r.factory = func(Poller, map[string]string, string) (Source, error) { return first, nil }
	p := Poller{ID: "p", CollectorID: "c", DeviceID: "d", VendorSiteID: "site", Source: "fronius", Revision: 1, Settings: Settings{PollMS: 2000, PushMS: 60000, Inverters: []Inverter{{Host: "master", Master: true}}}}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c := Config{CollectorID: "c", Pollers: []Poller{p}}
	if e := r.apply(ctx, c, nil); e != nil {
		t.Fatal(e)
	}
	<-first.entered
	send := func(end time.Time, token string) int {
		data, _ := json.Marshal(map[string]any{"pollerId": "p", "revision": 1, "windowEnd": end, "baseline": WindowMetrics{FailureRate: 0.01, P95ReadMS: 100}, "current": WindowMetrics{FailureRate: 0.03, P95ReadMS: 100}})
		req := httptest.NewRequest("POST", "/api/trial/windows", bytes.NewReader(data))
		req.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		r.Handler().ServeHTTP(w, req)
		return w.Code
	}
	end := time.Now().UTC().Truncate(15 * time.Minute)
	if code := send(end, "wrong"); code != 401 {
		t.Fatalf("monitor authentication: HTTP %d", code)
	}
	if code := send(end, "monitor"); code != 200 {
		t.Fatalf("first window: HTTP %d", code)
	}
	if code := send(end, "monitor"); code != 200 {
		t.Fatalf("duplicate window: HTTP %d", code)
	}
	select {
	case <-first.exited:
		t.Fatal("duplicate window counted as a second breach")
	default:
	}
	if code := send(end.Add(15*time.Minute), "monitor"); code != 200 {
		t.Fatalf("second window: HTTP %d", code)
	}
	select {
	case <-first.exited:
	case <-time.After(time.Second):
		t.Fatal("threshold did not cancel in-flight read")
	}
	<-r.generations[p.ID].done
	r.b.LiveOneURL = "http://localhost:9000"
	reopened, e := OpenRuntime(r.b, "lo_col_c_test", "receiver", "monitor", r.key)
	if e != nil {
		t.Fatal(e)
	}
	defer reopened.release()
	if e = reopened.apply(ctx, c, nil); e != nil {
		t.Fatal(e)
	}
	if !reopened.health[p.ID].Stopped || reopened.health[p.ID].Error != "reader-disabled" {
		t.Fatal("restart resumed disabled revision", reopened.health[p.ID])
	}
}

func TestReplayExportsComputedGusherBatches(t *testing.T) {
	fixture := Fixture{Source: "sigenergy", PollerID: "fixture-site", Revision: 1, At: time.Date(2026, 9, 12, 0, 0, 0, 0, time.UTC), Harvest: true, Raw: map[string]any{"data": map[string]any{"pvPower": 1.0}}, Expected: []Reading{{"value": 999.0}}}
	data, _ := json.Marshal(fixture)
	var batches []Batch
	report, e := ReplayBatches(bytes.NewReader(data), func(b Batch) error { batches = append(batches, b); return nil })
	if e != nil {
		t.Fatal(e)
	}
	if report.Mismatches != 1 || len(batches) != 1 || batches[0].VendorSiteID != "fixture-site" || batches[0].Readings[0]["value"] != float64(1000) {
		t.Fatal("export did not contain computed Go readings", report, batches)
	}
	wire, _ := json.Marshal(batches[0])
	if bytes.Contains(wire, []byte("apiKey")) {
		t.Fatal("replay export included ingestion credentials")
	}
}

func TestSimulatorRunAcceptsFractionalSeconds(t *testing.T) {
	s, e := OpenSupervisor(&simulator{}, filepath.Join(t.TempDir(), "run.json"), 600)
	if e != nil {
		t.Fatal(e)
	}
	req := httptest.NewRequest("POST", "/api/usher/control/site/run", strings.NewReader(`{"passkey":"test","runtimeSec":1.5}`))
	w := httptest.NewRecorder()
	s.SimulatorHandler("site", "test").ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("existing Usher fractional runtime rejected: HTTP %d", w.Code)
	}
	status := s.Status()
	if status.StopAt.Sub(*status.RequestedAt) != 1500*time.Millisecond {
		t.Fatal("fractional deadline rounded")
	}
}

func TestTrialIncidentDisablesWithoutWaitingForWindows(t *testing.T) {
	r := testRuntime(t)
	r.inspectorToken = "monitor"
	r.cached.Config.Pollers = []Poller{{ID: "p", Revision: 1}}
	req := httptest.NewRequest("POST", "/api/trial/incidents", strings.NewReader(`{"pollerId":"p","revision":1,"reason":"connection-disruption"}`))
	req.Header.Set("Authorization", "Bearer monitor")
	w := httptest.NewRecorder()
	r.Handler().ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("incident HTTP %d", w.Code)
	}
	if !r.trial["p"].Disabled || r.trial["p"].Reason != "connection-disruption" {
		t.Fatal("incident did not trip reader")
	}
}
func TestTrialWindowRequiresBothMeasurements(t *testing.T) {
	r := testRuntime(t)
	r.inspectorToken = "monitor"
	r.cached.Config.Pollers = []Poller{{ID: "p", Revision: 1}}
	req := httptest.NewRequest("POST", "/api/trial/windows", strings.NewReader(`{"pollerId":"p","revision":1,"windowEnd":"2026-09-12T00:00:00Z"}`))
	req.Header.Set("Authorization", "Bearer monitor")
	w := httptest.NewRecorder()
	r.Handler().ServeHTTP(w, req)
	if w.Code != 400 {
		t.Fatalf("missing measurements treated as healthy: HTTP %d", w.Code)
	}
}
