package gousher

import (
	"bytes"
	"compress/gzip"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
)

func AtomicWrite(path string, b []byte) error {
	if e := os.MkdirAll(filepath.Dir(path), 0700); e != nil {
		return e
	}
	f, e := os.CreateTemp(filepath.Dir(path), ".pending-")
	if e != nil {
		return e
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if e = f.Chmod(0600); e == nil {
		_, e = f.Write(b)
	}
	if e == nil {
		e = f.Sync()
	}
	ce := f.Close()
	if e == nil {
		e = ce
	}
	if e != nil {
		return e
	}
	if e = os.Rename(tmp, path); e != nil {
		return e
	}
	d, e := os.Open(filepath.Dir(path))
	if e != nil {
		return e
	}
	defer d.Close()
	return d.Sync()
}
func seal(key, data []byte) ([]byte, error) {
	c, e := aes.NewCipher(key)
	if e != nil {
		return nil, e
	}
	g, e := cipher.NewGCM(c)
	if e != nil {
		return nil, e
	}
	n := make([]byte, g.NonceSize())
	if _, e = rand.Read(n); e != nil {
		return nil, e
	}
	return g.Seal(n, n, data, []byte("gousher-v1")), nil
}
func unseal(key, data []byte) ([]byte, error) {
	c, e := aes.NewCipher(key)
	if e != nil {
		return nil, e
	}
	g, e := cipher.NewGCM(c)
	if e != nil {
		return nil, e
	}
	if len(data) < g.NonceSize() {
		return nil, errors.New("invalid credential cache")
	}
	return g.Open(nil, data[:g.NonceSize()], data[g.NonceSize():], []byte("gousher-v1"))
}

type Loss struct {
	Count int64     `json:"count"`
	First time.Time `json:"first"`
	Last  time.Time `json:"last"`
}
type StoreStats struct {
	Bytes  int64  `json:"bytes"`
	Budget int64  `json:"budget"`
	Count  int    `json:"count"`
	Oldest string `json:"oldest,omitempty"`
	Lost   Loss   `json:"lost"`
}
type Store struct {
	mu               sync.Mutex
	Dir              string
	Budget, Reserve  int64
	loss             Loss
	PruneDiagnostics func() error
}

func OpenStore(dir string, budget, reserve int64) (*Store, error) {
	if e := os.MkdirAll(dir, 0700); e != nil {
		return nil, e
	}
	s := &Store{Dir: dir, Budget: budget, Reserve: reserve}
	b, e := os.ReadFile(filepath.Join(dir, "loss.json"))
	if e == nil {
		if e = json.Unmarshal(b, &s.loss); e != nil {
			return nil, e
		}
	}
	entries, e := os.ReadDir(dir)
	if e != nil {
		return nil, e
	}
	for _, f := range entries {
		if strings.HasPrefix(f.Name(), ".pending-") {
			if e = os.Remove(filepath.Join(dir, f.Name())); e != nil {
				return nil, e
			}
		}
	}
	return s, nil
}
func (s *Store) files() ([]os.DirEntry, int64, error) {
	es, e := os.ReadDir(s.Dir)
	if e != nil {
		return nil, 0, e
	}
	var fs []os.DirEntry
	var total int64
	for _, f := range es {
		if f.IsDir() || f.Name() == "loss.json" || strings.HasPrefix(f.Name(), ".") {
			continue
		}
		i, e := f.Info()
		if e != nil {
			return nil, 0, e
		}
		total += i.Size()
		fs = append(fs, f)
	}
	sort.Slice(fs, func(i, j int) bool {
		a, ae := fs[i].Info()
		b, be := fs[j].Info()
		if ae == nil && be == nil && !a.ModTime().Equal(b.ModTime()) {
			return a.ModTime().Before(b.ModTime())
		}
		return fs[i].Name() < fs[j].Name()
	})
	return fs, total, nil
}
func free(dir string) (int64, error) {
	var st syscall.Statfs_t
	e := syscall.Statfs(dir, &st)
	return int64(st.Bavail) * int64(st.Bsize), e
}
func (s *Store) lose(f os.DirEntry) error {
	path := filepath.Join(s.Dir, f.Name())
	b, e := os.ReadFile(path)
	if e != nil {
		return e
	}
	var batch Batch
	_ = json.Unmarshal(b, &batch)
	loss := s.loss
	loss.Count++
	at := batch.MeasurementTime
	if at.IsZero() {
		i, e := f.Info()
		if e != nil {
			return e
		}
		at = i.ModTime()
	}
	if loss.First.IsZero() || at.Before(loss.First) {
		loss.First = at
	}
	if at.After(loss.Last) {
		loss.Last = at
	}
	data, _ := json.Marshal(loss)
	if e = AtomicWrite(filepath.Join(s.Dir, "loss.json"), data); e != nil {
		return e
	}
	s.loss = loss
	return os.Remove(path)
}
func (s *Store) Put(name string, data []byte, trackLoss bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if filepath.Base(name) != name || strings.HasPrefix(name, ".") || name == "loss.json" {
		return errors.New("invalid record name")
	}
	if int64(len(data)) > s.Budget {
		return errors.New("record exceeds storage budget")
	}
	if _, e := os.Stat(filepath.Join(s.Dir, name)); e == nil {
		return errors.New("record already exists")
	}
	fs, total, e := s.files()
	if e != nil {
		return e
	}
	available, e := free(s.Dir)
	if e != nil {
		return e
	}
	if available-int64(len(data)) < s.Reserve && s.PruneDiagnostics != nil {
		if e = s.PruneDiagnostics(); e != nil {
			return e
		}
		available, e = free(s.Dir)
		if e != nil {
			return e
		}
	}
	for len(fs) > 0 && (total+int64(len(data)) > s.Budget || available-int64(len(data)) < s.Reserve) {
		f := fs[0]
		fs = fs[1:]
		i, e := f.Info()
		if e != nil {
			return e
		}
		if trackLoss {
			e = s.lose(f)
		} else {
			e = os.Remove(filepath.Join(s.Dir, f.Name()))
		}
		if e != nil {
			return e
		}
		total -= i.Size()
		available, e = free(s.Dir)
		if e != nil {
			return e
		}
	}
	if available-int64(len(data)) < s.Reserve {
		return errors.New("free-space reserve reached")
	}
	return AtomicWrite(filepath.Join(s.Dir, name), data)
}
func (s *Store) Stats() StoreStats {
	s.mu.Lock()
	defer s.mu.Unlock()
	fs, n, _ := s.files()
	v := StoreStats{Bytes: n, Budget: s.Budget, Count: len(fs), Lost: s.loss}
	if len(fs) > 0 {
		v.Oldest = fs[0].Name()
	}
	return v
}
func (s *Store) Prune() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	fs, _, e := s.files()
	if e != nil {
		return e
	}
	for _, f := range fs {
		if e = os.Remove(filepath.Join(s.Dir, f.Name())); e != nil {
			return e
		}
	}
	return nil
}
func (s *Store) Head() (string, []byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	fs, _, e := s.files()
	if e != nil {
		return "", nil, e
	}
	if len(fs) == 0 {
		return "", nil, nil
	}
	name := fs[0].Name()
	b, e := os.ReadFile(filepath.Join(s.Dir, name))
	return name, b, e
}
func (s *Store) Ack(name string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if filepath.Base(name) != name {
		return errors.New("invalid record name")
	}
	e := os.Remove(filepath.Join(s.Dir, name))
	if os.IsNotExist(e) {
		return nil
	}
	if e != nil {
		return e
	}
	d, e := os.Open(s.Dir)
	if e != nil {
		return e
	}
	defer d.Close()
	return d.Sync()
}
func (s *Store) Journal(record any) error {
	b, e := json.Marshal(record)
	if e != nil {
		return e
	}
	var out bytes.Buffer
	z := gzip.NewWriter(&out)
	if _, e = z.Write(append(b, '\n')); e != nil {
		return e
	}
	if e = z.Close(); e != nil {
		return e
	}
	return s.Put(time.Now().UTC().Format("20060102T150405.000000000")+"-"+id()+".jsonl.gz", out.Bytes(), false)
}
func readLimited(r io.Reader, limit int64) ([]byte, error) {
	b, e := io.ReadAll(io.LimitReader(r, limit+1))
	if int64(len(b)) > limit {
		return nil, errors.New("response exceeds size limit")
	}
	return b, e
}

func redact(v any) any {
	switch x := v.(type) {
	case map[string]any:
		out := map[string]any{}
		for k, v := range x {
			lower := strings.ToLower(k)
			if strings.Contains(lower, "password") || strings.Contains(lower, "token") || strings.Contains(lower, "secret") || strings.Contains(lower, "cookie") || strings.Contains(lower, "authorization") || strings.Contains(lower, "apikey") || lower == "pwd" {
				continue
			}
			out[k] = redact(v)
		}
		return out
	case []any:
		out := make([]any, len(x))
		for i, v := range x {
			out[i] = redact(v)
		}
		return out
	default:
		return v
	}
}

// Discard records a durable loss before removing a corrupt or unusable pending batch.
func (s *Store) Discard(name string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if filepath.Base(name) != name {
		return errors.New("invalid record name")
	}
	entries, e := os.ReadDir(s.Dir)
	if e != nil {
		return e
	}
	for _, entry := range entries {
		if entry.Name() == name {
			return s.lose(entry)
		}
	}
	return nil
}
