// Package gousher is the database-free managed collector runtime.
package gousher

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"
)

type Reading map[string]any

// Batch never contains an ingestion credential. Authentication is attached in memory.
type Batch struct {
	ID              string    `json:"id"`
	PollerID        string    `json:"pollerId"`
	Revision        int       `json:"revision"`
	VendorSiteID    string    `json:"vendorSiteId"`
	Action          string    `json:"action"`
	SessionLabel    string    `json:"sessionLabel"`
	MeasurementTime time.Time `json:"measurementTime"`
	Readings        []Reading `json:"readings"`
}
type Inverter struct {
	Host    string `json:"host"`
	Master  bool   `json:"master"`
	Battery bool   `json:"battery"`
}
type Settings struct {
	Host         string     `json:"host,omitempty"`
	Port         int        `json:"port,omitempty"`
	UnitID       int        `json:"unitId,omitempty"`
	Inverters    []Inverter `json:"inverters,omitempty"`
	Region       string     `json:"region,omitempty"`
	AuthMode     string     `json:"authMode,omitempty"`
	PollMS       int        `json:"pollMs"`
	PushMS       int        `json:"pushMs"`
	ActivePollMS int        `json:"activePollMs,omitempty"`
	ActivePushMS int        `json:"activePushMs,omitempty"`
	PostRunMS    int        `json:"postRunMs,omitempty"`
}
type Poller struct {
	ID           string   `json:"id"`
	CollectorID  string   `json:"collectorId"`
	DeviceID     string   `json:"deviceId"`
	Source       string   `json:"source"`
	VendorSiteID string   `json:"vendorSiteId"`
	Revision     int      `json:"revision"`
	Paused       bool     `json:"paused"`
	Deleted      bool     `json:"deleted"`
	Settings     Settings `json:"settings"`
}
type Config struct {
	CollectorID string   `json:"collectorId"`
	Revision    string   `json:"revision"`
	Pollers     []Poller `json:"pollers"`
}
type Bootstrap struct {
	LiveOneURL    string   `json:"liveoneUrl"`
	ReceiverURL   string   `json:"receiverUrl"`
	DataDir       string   `json:"dataDir"`
	Listen        string   `json:"listen"`
	Mode          string   `json:"mode"`
	AllowedHosts  []string `json:"allowedHosts"`
	SpoolBytes    int64    `json:"spoolBytes"`
	BlackboxBytes int64    `json:"blackboxBytes"`
	ReserveBytes  int64    `json:"reserveBytes"`
}

func (b *Bootstrap) Validate() error {
	if b.Mode != "shadow" && b.Mode != "replay" {
		return errors.New("only replay and shadow modes are supported; production control is disabled")
	}
	for _, raw := range []string{b.LiveOneURL, b.ReceiverURL} {
		u, e := url.Parse(raw)
		if e != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
			return errors.New("invalid bootstrap URL")
		}
		if u.Scheme != "https" && !(u.Scheme == "http" && (u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1")) {
			return errors.New("remote URLs require HTTPS")
		}
	}
	a, _ := url.Parse(b.LiveOneURL)
	z, _ := url.Parse(b.ReceiverURL)
	if a.Host == z.Host || strings.Contains(z.Path, "/api/gush") {
		return errors.New("trial receiver must have a separate origin and cannot use production ingestion")
	}
	if b.DataDir == "" {
		b.DataDir = "./.gousher-data"
	}
	if b.Listen == "" {
		b.Listen = "127.0.0.1:8080"
	}
	if b.SpoolBytes == 0 {
		b.SpoolBytes = 128 << 20
	}
	if b.BlackboxBytes == 0 {
		b.BlackboxBytes = 32 << 20
	}
	if b.ReserveBytes == 0 {
		b.ReserveBytes = 64 << 20
	}
	if b.SpoolBytes < 1<<20 || b.BlackboxBytes < 1<<20 || b.ReserveBytes < 1<<20 {
		return errors.New("storage budgets must be at least 1 MiB")
	}
	return nil
}
func (p Poller) Validate(b Bootstrap) error {
	if p.ID == "" || p.DeviceID == "" || p.VendorSiteID == "" || p.Revision < 1 {
		return errors.New("invalid poller identity")
	}
	if _, ok := manifests[p.Source]; !ok {
		return errors.New("unsupported source")
	}
	if p.Settings.PollMS < 1000 || p.Settings.PushMS < 1000 || p.Settings.PollMS > 3600000 || p.Settings.PushMS > 3600000 {
		return errors.New("invalid cadence")
	}
	if p.Source == "sigenergy" && p.Settings.PollMS < 300000 {
		return errors.New("Sigenergy requires at least five minutes")
	}
	if p.Source == "selectronic" && p.Settings.PollMS < 60000 {
		return errors.New("Selectronic requires at least one minute")
	}
	hosts := []string{}
	if p.Source == "deepsea" {
		hosts = append(hosts, p.Settings.Host)
	}
	for _, i := range p.Settings.Inverters {
		hosts = append(hosts, i.Host)
	}
	for _, host := range hosts {
		ok := false
		for _, allowed := range b.AllowedHosts {
			if host == allowed {
				ok = true
			}
		}
		if !ok {
			return fmt.Errorf("device host is outside bootstrap restrictions")
		}
	}
	if p.Source == "deepsea" && (p.Settings.Port < 1 || p.Settings.Port > 65535 || p.Settings.UnitID < 1 || p.Settings.UnitID > 247) {
		return errors.New("invalid Modbus address")
	}
	if p.Source == "fronius" {
		masters := 0
		for _, i := range p.Settings.Inverters {
			if i.Master {
				masters++
			}
		}
		if masters != 1 || p.Settings.PollMS != 2000 {
			return errors.New("Fronius requires exactly one master")
		}
	}
	if p.Source == "sigenergy" && p.Settings.Region != "aus" && p.Settings.Region != "apac" && p.Settings.Region != "eu" && p.Settings.Region != "us" && p.Settings.Region != "cn" {
		return errors.New("invalid Sigenergy region")
	}
	return nil
}
func id() string {
	b := make([]byte, 16)
	if _, e := rand.Read(b); e != nil {
		panic(e)
	}
	return hex.EncodeToString(b)
}
func clone[T any](x T) T { b, _ := json.Marshal(x); var out T; _ = json.Unmarshal(b, &out); return out }

type Sample struct {
	At     time.Time      `json:"at"`
	Values map[string]any `json:"values"`
	Raw    any            `json:"raw"`
	Active bool           `json:"active"`
}
type Source interface {
	Sample(context.Context, time.Time) (Sample, error)
	Harvest(time.Time) (map[string]any, bool)
	Close() error
}
