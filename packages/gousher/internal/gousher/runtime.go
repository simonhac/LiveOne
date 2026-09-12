package gousher

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"time"
)

type Health struct {
	CollectionStale bool           `json:"collectionStale"`
	CollectionError string         `json:"collectionError,omitempty"`
	DeliveryError   string         `json:"deliveryError,omitempty"`
	ID              string         `json:"id"`
	AppliedRevision int            `json:"appliedRevision"`
	CollectionAt    *time.Time     `json:"collectionAt"`
	DeliveryAt      *time.Time     `json:"deliveryAt"`
	Error           string         `json:"error"`
	Stopped         bool           `json:"stopped"`
	Supervising     bool           `json:"supervising"`
	Storage         map[string]any `json:"storage,omitempty"`
}
type generation struct {
	p              Poller
	source         Source
	cancel         context.CancelFunc
	done           chan struct{}
	credentialHash string
}
type cache struct {
	Destination string                       `json:"destination"`
	Config      Config                       `json:"config"`
	Credentials map[string]map[string]string `json:"credentials"`
}
type inspectorState struct {
	Detail  map[string]any
	Running bool
	Count   int
}
type Runtime struct {
	trial                                map[string]trialState
	readerCancels                        map[string]readerCancellation
	inspector                            map[string]inspectorState
	factory                              func(Poller, map[string]string, string) (Source, error)
	b                                    Bootstrap
	token, receiverToken, inspectorToken string
	key                                  []byte
	client                               *http.Client
	mu                                   sync.Mutex
	generations                          map[string]*generation
	health                               map[string]Health
	cached                               cache
	etag                                 string
	spool, blackbox                      *Store
	release                              func()
	configError                          string
}

func OpenRuntime(b Bootstrap, token, receiverToken, inspectorToken string, key []byte) (*Runtime, error) {
	if e := b.Validate(); e != nil {
		return nil, e
	}
	if token == "" || receiverToken == "" || inspectorToken == "" || len(key) != 32 {
		return nil, errors.New("collector, receiver, inspector tokens and a 32-byte instance key are required")
	}
	if e := os.MkdirAll(b.DataDir, 0700); e != nil {
		return nil, e
	}
	release, e := lockInstance(filepath.Join(b.DataDir, "instance.lock"))
	if e != nil {
		return nil, e
	}
	ok := false
	defer func() {
		if !ok {
			release()
		}
	}()
	journal, e := OpenStore(filepath.Join(b.DataDir, "blackbox"), b.BlackboxBytes, b.ReserveBytes)
	if e != nil {
		return nil, e
	}
	spool, e := OpenStore(filepath.Join(b.DataDir, "spool"), b.SpoolBytes, b.ReserveBytes)
	if e != nil {
		return nil, e
	}
	spool.PruneDiagnostics = journal.Prune
	r := &Runtime{b: b, token: token, receiverToken: receiverToken, inspectorToken: inspectorToken, key: key, client: &http.Client{Timeout: 20 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, generations: map[string]*generation{}, health: map[string]Health{}, spool: spool, blackbox: journal, release: release, cached: cache{Credentials: map[string]map[string]string{}}}
	data, e := os.ReadFile(filepath.Join(b.DataDir, "config.enc"))
	if e == nil {
		plain, e := unseal(key, data)
		if e != nil {
			return nil, e
		}
		if e = json.Unmarshal(plain, &r.cached); e != nil {
			return nil, e
		}
		if r.cached.Destination != b.ReceiverURL {
			return nil, errors.New("cached trial destination cannot be changed")
		}
	} else if !os.IsNotExist(e) {
		return nil, e
	}
	if e = r.loadTrialState(); e != nil {
		return nil, e
	}
	ok = true
	return r, nil
}
func (r *Runtime) persist(c cache) error {
	data, e := json.Marshal(c)
	if e != nil {
		return e
	}
	if len(data) > 4<<20 {
		return errors.New("configuration exceeds cache budget")
	}
	encrypted, e := seal(r.key, data)
	if e != nil {
		return e
	}
	return AtomicWrite(filepath.Join(r.b.DataDir, "config.enc"), encrypted)
}
func (r *Runtime) api(ctx context.Context, method, path string, body any, etag string) ([]byte, int, string, error) {
	var b []byte
	var e error
	if body != nil {
		b, e = json.Marshal(body)
		if e != nil {
			return nil, 0, "", e
		}
	}
	req, e := http.NewRequestWithContext(ctx, method, r.b.LiveOneURL+path, bytes.NewReader(b))
	if e != nil {
		return nil, 0, "", e
	}
	req.Header.Set("Authorization", "Bearer "+r.token)
	req.Header.Set("Content-Type", "application/json")
	if etag != "" {
		req.Header.Set("If-None-Match", etag)
	}
	res, e := r.client.Do(req)
	if e != nil {
		return nil, 0, "", errors.New("control plane unavailable")
	}
	defer res.Body.Close()
	data, e := readLimited(res.Body, 4<<20)
	if e != nil {
		return nil, res.StatusCode, "", e
	}
	if res.StatusCode != 200 && res.StatusCode != 304 {
		return nil, res.StatusCode, "", fmt.Errorf("control plane HTTP %d", res.StatusCode)
	}
	return data, res.StatusCode, res.Header.Get("ETag"), nil
}
func credentialHash(c map[string]string) string {
	b, _ := json.Marshal(c)
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}
func connectionSettings(s Settings) Settings {
	s.PollMS = 0
	s.PushMS = 0
	s.ActivePollMS = 0
	s.ActivePushMS = 0
	s.PostRunMS = 0
	return s
}
func (r *Runtime) apply(ctx context.Context, c Config, creds map[string]map[string]string) error {
	if r.token != "" && !strings.HasPrefix(r.token, "lo_col_"+c.CollectorID+"_") {
		return errors.New("collector token does not match cached assignment")
	}
	if len(c.Pollers) > 500 {
		return errors.New("too many pollers")
	}
	seen := map[string]bool{}
	for _, p := range c.Pollers {
		if seen[p.ID] || p.CollectorID != c.CollectorID {
			return errors.New("invalid collector assignment")
		}
		seen[p.ID] = true
		if e := p.Validate(r.b); e != nil {
			return e
		}
	}
	// Missing entries are never interpreted as deletion: a tombstone is required.
	for _, p := range r.cached.Config.Pollers {
		if !seen[p.ID] {
			return errors.New("configuration omitted an unacknowledged identity")
		}
	}
	for _, p := range c.Pollers {
		old := r.generations[p.ID]
		hash := credentialHash(creds[p.ID])
		if old != nil {
			if old.p.DeviceID != p.DeviceID || old.p.Source != p.Source || old.p.VendorSiteID != p.VendorSiteID || old.p.CollectorID != p.CollectorID || p.Revision < old.p.Revision {
				return errors.New("immutable identity or stale revision")
			}
			if p.Revision == old.p.Revision && !reflect.DeepEqual(old.p, p) {
				return errors.New("settings changed without a new revision")
			}
			if reflect.DeepEqual(old.p, p) && old.credentialHash == hash {
				continue
			}
		}
		// Deletion and connection changes cannot detach an outstanding control latch.
		// In trial mode the transport cannot release it: retain the applied config
		// and require supervision to finish with its existing owner.
		state, stateErr := os.ReadFile(filepath.Join(r.b.DataDir, "controls", p.ID+".json"))
		if stateErr != nil && !os.IsNotExist(stateErr) {
			return stateErr
		}
		if stateErr == nil {
			var control ControlStatus
			if json.Unmarshal(state, &control) != nil {
				return errors.New("invalid persisted control state")
			}
			if control.Latched && (p.Deleted || old == nil || !reflect.DeepEqual(connectionSettings(old.p.Settings), connectionSettings(p.Settings))) {
				r.mu.Lock()
				h := r.health[p.ID]
				h.ID = p.ID
				h.Supervising = true
				h.Error = "supervision-pending"
				r.health[p.ID] = h
				r.mu.Unlock()
				return errors.New("generator supervision must complete before deletion or connection changes")
			}
		}
		var source Source
		var e error
		reuse := old != nil && !p.Deleted && old.credentialHash == hash && reflect.DeepEqual(connectionSettings(old.p.Settings), connectionSettings(p.Settings))
		if reuse {
			source = old.source
		} else if !p.Deleted {
			factory := r.factory
			if factory == nil {
				factory = newSource
			}
			source, e = factory(p, creds[p.ID], r.b.Mode)
			if e != nil {
				r.setError(p.ID, "credential-unavailable")
				return e
			}
		}
		next := clone(r.cached)
		next.Destination = r.b.ReceiverURL
		next.Config.CollectorID = c.CollectorID
		next.Config.Revision = c.Revision
		found := false
		for i, v := range next.Config.Pollers {
			if v.ID == p.ID {
				next.Config.Pollers[i] = p
				found = true
			}
		}
		if !found {
			next.Config.Pollers = append(next.Config.Pollers, p)
		}
		if next.Credentials == nil {
			next.Credentials = map[string]map[string]string{}
		}
		next.Credentials[p.ID] = creds[p.ID]
		if p.Deleted {
			delete(next.Credentials, p.ID)
		}
		if e = r.persist(next); e != nil {
			if source != nil && !reuse {
				source.Close()
			}
			r.setError(p.ID, "storage-failed")
			return e
		}
		if old != nil {
			old.cancel()
			<-old.done
			if !reuse && old.source != nil {
				old.source.Close()
			}
		}
		child, cancel := context.WithCancel(ctx)
		g := &generation{p: p, source: source, cancel: cancel, done: make(chan struct{}), credentialHash: hash}
		r.generations[p.ID] = g
		r.mu.Lock()
		r.cached = next
		if !reuse {
			delete(r.inspector, p.ID)
		}
		h := r.health[p.ID]
		h.ID = p.ID
		h.AppliedRevision = p.Revision
		h.Error = ""
		disabled := r.trial[p.ID].Revision == p.Revision && r.trial[p.ID].Disabled
		if r.readerCancels == nil {
			r.readerCancels = map[string]readerCancellation{}
		}
		r.readerCancels[p.ID] = readerCancellation{p.Revision, cancel}
		h.Stopped = p.Paused || p.Deleted || r.b.Mode == "replay" || disabled
		if disabled {
			h.Error = "reader-disabled"
		}
		r.health[p.ID] = h
		r.mu.Unlock()
		if p.Paused || p.Deleted || r.b.Mode == "replay" || disabled {
			close(g.done)
		} else {
			go r.collect(child, g)
		}
	}
	return nil
}
func (r *Runtime) setError(id, code string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if id == "" {
		r.configError = code
		return
	}
	h := r.health[id]
	h.ID = id
	h.Error = code
	if code == "collection-failed" {
		h.CollectionError = code
	}
	if code == "delivery-failed" {
		h.DeliveryError = code
	}
	r.health[id] = h
}
func (r *Runtime) collect(ctx context.Context, g *generation) {
	defer close(g.done)
	defer func() {
		r.mu.Lock()
		h := r.health[g.p.ID]
		h.Stopped = true
		r.health[g.p.ID] = h
		r.mu.Unlock()
	}()
	p := g.p
	nextPush := time.Now()
	lastActive := false
	var holdUntil time.Time
	for {
		if ctx.Err() != nil {
			return
		}
		started := time.Now()
		readCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		sample, e := g.source.Sample(readCtx, started)
		cancel()
		if ctx.Err() != nil {
			return
		}
		if e != nil {
			if errors.Is(e, ErrSessionEvicted) {
				if e := r.disableReader(p.ID, p.Revision, "session-evicted"); e != nil {
					r.setError("", "storage-failed")
				}
				return
			}
			r.setError(p.ID, "collection-failed")
		} else {
			if sample.Active {
				holdUntil = started.Add(time.Duration(p.Settings.PostRunMS) * time.Millisecond)
			}
			due := !started.Before(nextPush) || sample.Active != lastActive
			var expected []Reading
			var values map[string]any
			ok := false
			if due {
				values, ok = g.source.Harvest(started)
				if ok {
					expected = Readings(p.Source, values)
				}
			}
			detail := map[string]any{"values": clone(sample.Values), "at": sample.At}
			if source, ok := g.source.(interface {
				Inspector(time.Time) map[string]any
			}); ok {
				detail = source.Inspector(sample.At)
			}
			r.mu.Lock()
			if r.inspector == nil {
				r.inspector = map[string]inspectorState{}
			}
			r.inspector[p.ID] = inspectorState{Detail: clone(detail), Running: sample.Active, Count: len(expected)}
			h := r.health[p.ID]
			h.CollectionAt = &sample.At
			h.CollectionError = ""
			if h.Error == "collection-failed" {
				h.Error = ""
			}
			r.health[p.ID] = h
			r.mu.Unlock()
			// Raw capture is asynchronous from production: these are exclusively this reader's inputs.
			record := map[string]any{"pollerId": p.ID, "revision": p.Revision, "source": p.Source, "at": sample.At, "raw": redact(sample.Raw), "settings": p.Settings, "harvest": due, "expected": expected}
			if e = r.blackbox.Journal(record); e != nil {
				r.setError(p.ID, "storage-failed")
			}
			if due && ok && len(expected) > 0 {
				batch := Batch{ID: id(), PollerID: p.ID, Revision: p.Revision, VendorSiteID: p.VendorSiteID, Action: "store", MeasurementTime: sample.At, Readings: expected}
				batch.SessionLabel = "gousher/" + batch.ID
				b, _ := json.Marshal(batch)
				if e = r.spool.Put(started.UTC().Format("20060102T150405.000000000")+"-"+batch.ID+".json", b, true); e != nil {
					r.setError(p.ID, "storage-failed")
				}
			}
			if due {
				push := p.Settings.PushMS
				if sample.Active && p.Settings.ActivePushMS > 0 {
					push = p.Settings.ActivePushMS
				}
				nextPush = nextBoundary(started, time.Duration(push)*time.Millisecond)
			}
			lastActive = sample.Active
		}
		poll := p.Settings.PollMS
		if (sample.Active || started.Before(holdUntil)) && p.Settings.ActivePollMS > 0 {
			poll = p.Settings.ActivePollMS
		}
		next := nextBoundary(started, time.Duration(poll)*time.Millisecond)
		if !sleep(ctx, time.Until(next)) {
			return
		}
	}
}
func nextBoundary(now time.Time, period time.Duration) time.Time {
	return now.Truncate(period).Add(period)
}
func sleep(ctx context.Context, d time.Duration) bool {
	if d < 0 {
		d = 0
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}
func (r *Runtime) delivery(ctx context.Context) {
	backoff := time.Second
	for {
		if ctx.Err() != nil {
			return
		}
		name, data, e := r.spool.Head()
		if e != nil || name == "" {
			if !sleep(ctx, time.Second) {
				return
			}
			continue
		}
		var b Batch
		if json.Unmarshal(data, &b) != nil {
			r.setError(b.PollerID, "storage-failed")
			if e := r.spool.Discard(name); e != nil && !sleep(ctx, 30*time.Second) {
				return
			}
			continue
		}
		req, e := http.NewRequestWithContext(ctx, "POST", r.b.ReceiverURL, bytes.NewReader(data))
		if e != nil {
			return
		}
		req.Header.Set("Authorization", "Bearer "+r.receiverToken)
		req.Header.Set("Content-Type", "application/json")
		res, e := r.client.Do(req)
		acked := false
		if e == nil {
			raw, re := readLimited(res.Body, 4096)
			res.Body.Close()
			var ack struct {
				ID      string `json:"id"`
				Durable bool   `json:"durable"`
			}
			acked = re == nil && res.StatusCode == 200 && json.Unmarshal(raw, &ack) == nil && ack.ID == b.ID && ack.Durable
		}
		if acked {
			if e = r.spool.Ack(name); e == nil {
				now := time.Now()
				r.mu.Lock()
				h := r.health[b.PollerID]
				h.ID = b.PollerID
				h.DeliveryAt = &now
				h.DeliveryError = ""
				if h.Error == "delivery-failed" {
					h.Error = ""
				}
				r.health[b.PollerID] = h
				r.mu.Unlock()
				backoff = time.Second
				continue
			}
		}
		r.setError(b.PollerID, "delivery-failed")
		if !sleep(ctx, backoff) {
			return
		}
		backoff *= 2
		if backoff > time.Minute {
			backoff = time.Minute
		}
	}
}
func (r *Runtime) statuses() []Health {
	sp := r.spool.Stats()
	bb := r.blackbox.Stats()
	r.mu.Lock()
	defer r.mu.Unlock()
	out := []Health{}
	for _, h := range r.health {
		if !h.Stopped && h.CollectionAt != nil {
			for _, p := range r.cached.Config.Pollers {
				if p.ID == h.ID {
					threshold := 2 * time.Duration(p.Settings.PollMS) * time.Millisecond
					if threshold < time.Minute {
						threshold = time.Minute
					}
					h.CollectionStale = time.Since(*h.CollectionAt) > threshold
					break
				}
			}
		}
		h.Storage = map[string]any{"spoolBytes": sp.Bytes, "blackboxBytes": bb.Bytes, "dropped": sp.Lost.Count, "oldestPending": sp.Oldest}
		if !sp.Lost.First.IsZero() {
			h.Storage["lostFirst"] = sp.Lost.First
			h.Storage["lostLast"] = sp.Lost.Last
		}
		out = append(out, h)
	}
	return out
}
func (r *Runtime) sync(ctx context.Context) error {
	raw, status, etag, e := r.api(ctx, "GET", "/api/collectors/me/config", nil, r.etag)
	if e != nil {
		return e
	}
	var c Config
	if status == 304 {
		c = r.cached.Config
	} else {
		var envelope struct {
			Config
			Destination string `json:"destination"`
		}
		if e = json.Unmarshal(raw, &envelope); e != nil {
			return e
		}
		if envelope.Destination != r.b.ReceiverURL {
			return errors.New("trial destination does not match bootstrap restriction")
		}
		c = envelope.Config
	}
	creds := map[string]map[string]string{}
	for _, p := range c.Pollers {
		if p.Deleted {
			continue
		}
		if p.Source != "selectronic" && p.Source != "sigenergy" {
			creds[p.ID] = map[string]string{}
			continue
		}
		data, _, _, e := r.api(ctx, "GET", "/api/collectors/me/credentials?pollerId="+p.ID, nil, "")
		if e != nil {
			return e
		}
		var v struct {
			Revision    int               `json:"revision"`
			Credentials map[string]string `json:"credentials"`
		}
		if e = json.Unmarshal(data, &v); e != nil {
			return e
		}
		if v.Revision != p.Revision {
			return errors.New("credentials changed during configuration fetch")
		}
		creds[p.ID] = v.Credentials
	}
	if e = r.apply(ctx, c, creds); e != nil {
		return e
	}
	if status != 304 {
		r.etag = etag
	}
	_, _, _, e = r.api(ctx, "POST", "/api/collectors/me/status", map[string]any{"pollers": r.statuses()}, "")
	return e
}
func (r *Runtime) Run(ctx context.Context) error {
	defer r.release()
	if len(r.cached.Config.Pollers) > 0 {
		c := clone(r.cached)
		if e := r.apply(ctx, c.Config, c.Credentials); e != nil {
			return e
		}
	}
	var workers sync.WaitGroup
	workers.Add(1)
	go func() { defer workers.Done(); r.delivery(ctx) }()
	defer func() {
		for _, g := range r.generations {
			g.cancel()
			<-g.done
			if g.source != nil {
				g.source.Close()
			}
		}
		workers.Wait()
		r.client.CloseIdleConnections()
	}()
	backoff := 30 * time.Second
	for {
		e := r.sync(ctx)
		r.mu.Lock()
		if e != nil {
			r.configError = "config-rejected"
		} else {
			r.configError = ""
		}
		r.mu.Unlock()
		if !sleep(ctx, backoff) {
			return nil
		}
		if e == nil {
			backoff = 30 * time.Second
		} else {
			backoff *= 2
			if backoff > 5*time.Minute {
				backoff = 5 * time.Minute
			}
		}
	}
}
