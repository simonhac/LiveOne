package gousher

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"sort"
	"strconv"
	"sync"
	"time"
)

type Register struct {
	Key     string  `json:"key"`
	Address int     `json:"address"`
	Words   int     `json:"words"`
	Signed  bool    `json:"signed"`
	Scale   float64 `json:"scale"`
}

func Decode(r Register, words []uint16) any {
	if len(words) < r.Words || r.Words < 1 || r.Words > 2 {
		return nil
	}
	n := uint64(words[0])
	if r.Words == 2 {
		n = n<<16 | uint64(words[1])
	}
	top := uint64(1) << (r.Words * 16)
	sentinel := top - 8
	if r.Signed {
		sentinel = top/2 - 8
	}
	if n >= sentinel && (!r.Signed || n < top/2) {
		return nil
	}
	v := int64(n)
	if r.Signed && n >= top/2 {
		v -= int64(top)
	}
	return float64(v) * r.Scale
}

// Modbus is the sole device-write boundary. No replay/shadow path can send a write function.
// Each transaction has a socket deadline; a dead connection cannot hold the mutex indefinitely.
type Modbus struct {
	mu         sync.Mutex
	host       string
	port, unit int
	mode       string
	conn       net.Conn
	seq        uint16
}

func NewModbus(host string, port, unit int, mode string) *Modbus {
	return &Modbus{host: host, port: port, unit: unit, mode: mode}
}
func (m *Modbus) transaction(ctx context.Context, pdu []byte) ([]byte, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(pdu) == 0 {
		return nil, errors.New("empty Modbus request")
	}
	if pdu[0] != 3 {
		return nil, errors.New("device writes are prohibited by the trial transport")
	}
	if m.mode == "replay" {
		return nil, errors.New("replay transport cannot contact a device")
	}
	deadline := time.Now().Add(5 * time.Second)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	if e := ctx.Err(); e != nil {
		return nil, e
	}
	if m.conn == nil {
		d := net.Dialer{Deadline: deadline}
		c, e := d.DialContext(ctx, "tcp", net.JoinHostPort(m.host, strconv.Itoa(m.port)))
		if e != nil {
			return nil, errors.New("Modbus connection failed")
		}
		m.conn = c
	}
	_ = m.conn.SetDeadline(deadline)
	m.seq++
	frame := make([]byte, 7+len(pdu))
	binary.BigEndian.PutUint16(frame, m.seq)
	binary.BigEndian.PutUint16(frame[4:], uint16(len(pdu)+1))
	frame[6] = byte(m.unit)
	copy(frame[7:], pdu)
	fail := func(e error) ([]byte, error) { m.conn.Close(); m.conn = nil; return nil, e }
	if _, e := io.Copy(m.conn, bytesReader(frame)); e != nil {
		return fail(errors.New("Modbus write failed"))
	}
	header := make([]byte, 7)
	if _, e := io.ReadFull(m.conn, header); e != nil {
		return fail(errors.New("Modbus response timed out"))
	}
	length := int(binary.BigEndian.Uint16(header[4:]))
	if binary.BigEndian.Uint16(header) != m.seq || binary.BigEndian.Uint16(header[2:]) != 0 || header[6] != byte(m.unit) || length < 2 || length > 254 {
		return fail(errors.New("invalid Modbus header"))
	}
	body := make([]byte, length-1)
	if _, e := io.ReadFull(m.conn, body); e != nil {
		return fail(errors.New("incomplete Modbus response"))
	}
	if body[0] != pdu[0] {
		return nil, errors.New("Modbus exception")
	}
	return body, nil
}
func (m *Modbus) Read(ctx context.Context, address, count int) ([]uint16, error) {
	if address < 0 || count < 1 || count > 125 || address+count > 65536 {
		return nil, errors.New("invalid register range")
	}
	pdu := []byte{3, byte(address >> 8), byte(address), byte(count >> 8), byte(count)}
	b, e := m.transaction(ctx, pdu)
	if e != nil {
		return nil, e
	}
	if len(b) != 2+2*count || int(b[1]) != 2*count {
		return nil, errors.New("invalid register count")
	}
	out := make([]uint16, count)
	for i := range out {
		out[i] = binary.BigEndian.Uint16(b[2+i*2:])
	}
	return out, nil
}
func (m *Modbus) WriteControl(ctx context.Context, fn int) error {
	key := 35700 + fn
	_, e := m.transaction(ctx, []byte{16, 16, 8, 0, 2, 4, byte(key >> 8), byte(key), byte((65535 - key) >> 8), byte(65535 - key)})
	return e
}
func (m *Modbus) Close() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.conn == nil {
		return nil
	}
	e := m.conn.Close()
	m.conn = nil
	return e
}

// Small reader avoids a second write-capable transport implementation.
type byteReader struct{ b []byte }

func bytesReader(b []byte) *byteReader { return &byteReader{b} }
func (r *byteReader) Read(p []byte) (int, error) {
	if len(r.b) == 0 {
		return 0, io.EOF
	}
	n := copy(p, r.b)
	r.b = r.b[n:]
	return n, nil
}

type DeepSea struct {
	transport *Modbus
	latest    Sample
}

func (d *DeepSea) Sample(ctx context.Context, at time.Time) (Sample, error) {
	defer d.transport.Close() // DSE/NAT idle sockets are not reused between polls.
	s := Sample{At: at, Values: map[string]any{}}
	raw := map[string]any{}
	regs := append([]Register(nil), registerMap.Registers...)
	sort.Slice(regs, func(i, j int) bool { return regs[i].Address < regs[j].Address })
	success := 0
	for start := 0; start < len(regs); {
		end := start + 1
		base := regs[start].Address
		limit := base + regs[start].Words
		for end < len(regs) && regs[end].Address/256 == base/256 && regs[end].Address-limit <= 16 && regs[end].Address+regs[end].Words-base <= 125 {
			limit = regs[end].Address + regs[end].Words
			end++
		}
		words, e := d.transport.Read(ctx, base, limit-base)
		for _, r := range regs[start:end] {
			var w []uint16
			if e == nil {
				w = words[r.Address-base : r.Address-base+r.Words]
			} else {
				var re error
				w, re = d.transport.Read(ctx, r.Address, r.Words)
				if re != nil {
					raw[r.Key] = map[string]any{"error": "register unavailable"}
					continue
				}
			}
			success++
			s.Values[r.Key] = Decode(r, w)
			raw[r.Key] = w
		}
		start = end
		if ctx.Err() != nil {
			return s, ctx.Err()
		}
	}
	if success == 0 {
		return s, errors.New("no DSE registers could be read")
	}
	s = deriveDSE(s, raw)
	d.latest = s
	return s, nil
}
func (d *DeepSea) Harvest(time.Time) (map[string]any, bool) {
	return d.latest.Values, d.latest.Values != nil
}
func (d *DeepSea) Close() error { return d.transport.Close() }
func newSource(p Poller, creds map[string]string, mode string) (Source, error) {
	switch p.Source {
	case "deepsea":
		return &DeepSea{transport: NewModbus(p.Settings.Host, p.Settings.Port, p.Settings.UnitID, mode)}, nil
	case "fronius":
		return NewFronius(p), nil
	case "selectronic", "sigenergy":
		if creds["password"] == "" {
			return nil, errors.New("vendor credentials are unavailable")
		}
		return NewCloud(p, creds), nil
	}
	return nil, fmt.Errorf("unsupported source")
}

func deriveDSE(s Sample, raw map[string]any) Sample {
	for _, v := range []struct {
		from, to string
		bit      uint
	}{{"digInUnnamed1To16", "remoteStartInput", 15}, {"digOutUnnamed1To16", "fuelRelay", 15}, {"digOutUnnamed1To16", "atSpeed", 12}, {"digOutUnnamed1To16", "crankRelay", 11}} {
		if n, ok := number(s.Values[v.from]); ok {
			s.Values[v.to] = float64((uint16(n) >> v.bit) & 1)
		}
	}
	if n, ok := number(s.Values["controlMode"]); ok {
		k := strconv.Itoa(int(n))
		name := registerMap.Modes[k]
		if name == "" {
			name = k
		}
		s.Values["controlModeName"] = name
	}
	rpm, _ := number(s.Values["engineRpm"])
	hz, _ := number(s.Values["genFreqHz"])
	s.Active = rpm > 0 || hz > 0
	s.Raw = raw
	return s
}
