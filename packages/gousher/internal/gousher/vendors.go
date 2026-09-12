package gousher

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/sha256"
	"embed"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

//go:embed assets/*
var assets embed.FS
var manifests map[string][]map[string]any
var registerMap struct {
	Registers []Register        `json:"registers"`
	Modes     map[string]string `json:"controlModes"`
	Engines   map[string]string `json:"engineStates"`
}

func init() {
	b, _ := assets.ReadFile("assets/manifests.json")
	if e := json.Unmarshal(b, &manifests); e != nil {
		panic(e)
	}
	b, _ = assets.ReadFile("assets/registers.json")
	if e := json.Unmarshal(b, &registerMap); e != nil {
		panic(e)
	}
}
func Readings(source string, values map[string]any) []Reading {
	out := []Reading{}
	for _, m := range manifests[source] {
		v := values[m["key"].(string)]
		if v == nil {
			continue
		}
		if f, ok := v.(float64); ok && (math.IsNaN(f) || math.IsInf(f, 0)) {
			continue
		}
		r := Reading{}
		for k, x := range m {
			if k != "key" {
				r[k] = x
			}
		}
		for _, k := range []string{"logicalPathStem", "subsystem", "transform"} {
			if _, ok := r[k]; !ok {
				r[k] = nil
			}
		}
		if r["defaultName"] == nil {
			r["defaultName"] = r["physicalPathTail"]
		}
		r["value"] = v
		out = append(out, r)
	}
	return out
}
func number(x any) (float64, bool) {
	switch v := x.(type) {
	case float64:
		return v, !math.IsNaN(v) && !math.IsInf(v, 0)
	case string:
		if strings.TrimSpace(v) == "" {
			return 0, false
		}
		f, e := strconv.ParseFloat(v, 64)
		return f, e == nil && !math.IsNaN(f) && !math.IsInf(f, 0)
	}
	return 0, false
}
func obj(x any) map[string]any { v, _ := x.(map[string]any); return v }
func pick(m map[string]any, keys ...string) any {
	for _, k := range keys {
		if v, ok := number(m[k]); ok {
			return v
		}
	}
	return nil
}
func round(v float64) float64 { return math.Floor(v+0.5) + 0 }
func scale(v any, f float64, rounded bool) any {
	n, ok := number(v)
	if !ok {
		return nil
	}
	n *= f
	if rounded {
		n = round(n)
	}
	return n
}
func Normalize(source string, raw map[string]any, at time.Time) (Sample, error) {
	s := Sample{At: at, Raw: raw, Values: map[string]any{}}
	v := s.Values
	switch source {
	case "selectronic":
		m := obj(raw["items"])
		if m == nil {
			return s, errors.New("missing Selectronic items")
		}
		mapping := map[string]string{"solarInverterW": "solarinverter_w", "shuntW": "shunt_w", "loadW": "load_w", "batteryW": "battery_w", "gridW": "grid_w", "batterySOC": "battery_soc", "faultCode": "fault_code", "faultTimestamp": "fault_ts", "generatorStatus": "gen_status", "solarKwhTotal": "solar_wh_total", "loadKwhTotal": "load_wh_total", "batteryInKwhTotal": "battery_in_wh_total", "batteryOutKwhTotal": "battery_out_wh_total", "gridInKwhTotal": "grid_in_wh_total", "gridOutKwhTotal": "grid_out_wh_total"}
		for field, key := range mapping {
			f := 1.0
			if strings.Contains(field, "KwhTotal") {
				f = 1000
			}
			v[field] = scale(selectNumber(m[key]), f, strings.HasSuffix(field, "W") || f == 1000)
		}
		a, ok := number(selectNumber(m["solarinverter_w"]))
		b, ok2 := number(selectNumber(m["shunt_w"]))
		if ok && ok2 {
			v["solarW"] = round(a + b)
		}
		if n, ok := number(m["timestamp"]); ok && n != 0 {
			s.At = time.UnixMilli(int64(n * 1000))
		}
	case "sigenergy":
		m := raw
		if raw["data"] != nil {
			m = obj(raw["data"])
		}
		if m == nil {
			return s, errors.New("invalid energy flow")
		}
		v["solarW"] = scale(pick(m, "pvPower", "pv_power", "solarPower"), 1000, true)
		v["batteryW"] = scale(pick(m, "batteryPower", "essPower", "batteryChargeDischargePower"), -1000, true)
		v["gridW"] = scale(pick(m, "buySellPower", "gridPower", "gridActivePower"), -1000, true)
		v["loadW"] = scale(pick(m, "loadPower", "consumptionPower"), 1000, true)
		v["batterySOC"] = pick(m, "batterySoc", "soc", "batterySOC")
		var ev any
		for _, key := range []string{"evPower", "acPower", "evsePower", "chargerPower"} {
			n, ok := number(m[key])
			if ok {
				if ev == nil {
					ev = n
				}
				if n != 0 {
					ev = n
					break
				}
			}
		}
		v["evW"] = scale(ev, 1000, true)
	default:
		return s, errors.New("unsupported normalization")
	}
	if len(Readings(source, v)) == 0 {
		return s, errors.New("response contains no measurements")
	}
	return s, nil
}

var ErrSessionEvicted = errors.New("vendor session was evicted; reader disabled")

type Cloud struct {
	refreshToken    string
	p               Poller
	creds           map[string]string
	client          *http.Client
	token, authMode string
	expires         time.Time
	latest          Sample
}

func NewCloud(p Poller, creds map[string]string) *Cloud {
	jar, _ := cookiejar.New(nil)
	return &Cloud{p: p, creds: creds, client: &http.Client{Timeout: 15 * time.Second, Jar: jar, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
}
func (c *Cloud) request(ctx context.Context, method, u string, body []byte, headers map[string]string) (map[string]any, int, error) {
	r, e := http.NewRequestWithContext(ctx, method, u, bytes.NewReader(body))
	if e != nil {
		return nil, 0, e
	}
	r.Header.Set("User-Agent", "liveone/1.0")
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	res, e := c.client.Do(r)
	if e != nil {
		return nil, 0, errors.New("vendor request failed")
	}
	defer res.Body.Close()
	b, e := readLimited(res.Body, 2<<20)
	if e != nil {
		return nil, res.StatusCode, e
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, res.StatusCode, fmt.Errorf("vendor HTTP %d", res.StatusCode)
	}
	var out map[string]any
	if e = json.Unmarshal(b, &out); e != nil {
		return nil, res.StatusCode, errors.New("invalid vendor JSON")
	}
	if code, ok := number(out["code"]); ok && code != 0 && code != 200 {
		return nil, res.StatusCode, errors.New("vendor rejected request")
	}
	return out, res.StatusCode, nil
}
func (c *Cloud) login(ctx context.Context) error {
	if c.p.Source == "selectronic" {
		form := url.Values{"email": {c.creds["email"]}, "pwd": {c.creds["password"]}}
		r, e := http.NewRequestWithContext(ctx, "POST", "https://select.live/login", strings.NewReader(form.Encode()))
		if e != nil {
			return e
		}
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		res, e := c.client.Do(r)
		if e != nil {
			return errors.New("vendor authentication failed")
		}
		defer res.Body.Close()
		b, e := readLimited(res.Body, 1<<20)
		if e != nil {
			return e
		}
		loc := res.Header.Get("Location")
		u, _ := url.Parse("https://select.live")
		if ((res.StatusCode == 302 || res.StatusCode == 301) && (strings.Contains(loc, "dashboard") || strings.Contains(loc, "systems"))) || (res.StatusCode == 200 && len(c.client.Jar.Cookies(u)) > 0 && !bytes.Contains(b, []byte("Bad email address or password"))) {
			c.token = "cookie"
			c.expires = time.Now().Add(time.Hour)
			return nil
		}
		return errors.New("vendor authentication refused")
	}
	modes := []string{c.p.Settings.AuthMode}
	if modes[0] == "" {
		modes = []string{"legacy"}
	}
	if modes[0] == "auto" {
		modes = []string{"legacy", "openapi"}
	}
	for _, mode := range modes {
		var u string
		var b []byte
		h := map[string]string{}
		if mode == "legacy" {
			key := []byte("sigensigensigenp")
			block, e := aes.NewCipher(key)
			if e != nil {
				return e
			}
			plain := []byte(c.creds["password"])
			pad := 16 - len(plain)%16
			plain = append(plain, bytes.Repeat([]byte{byte(pad)}, pad)...)
			enc := make([]byte, len(plain))
			cipher.NewCBCEncrypter(block, key).CryptBlocks(enc, plain)
			sum := sha256.Sum256([]byte("liveone:" + c.creds["username"] + ":" + c.p.Settings.Region))
			form := url.Values{"grant_type": {"password"}, "username": {c.creds["username"]}, "password": {base64.StdEncoding.EncodeToString(enc)}, "scope": {"server"}, "userDeviceId": {hex.EncodeToString(sum[:16])}}
			b = []byte(form.Encode())
			u = "https://api-" + c.p.Settings.Region + ".sigencloud.com/auth/oauth/token"
			h["Content-Type"] = "application/x-www-form-urlencoded"
			h["Authorization"] = "Basic " + base64.StdEncoding.EncodeToString([]byte("sigen:sigen"))
		} else {
			u = "https://openapi-" + c.p.Settings.Region + ".sigencloud.com/openapi/auth/login/password"
			b, _ = json.Marshal(map[string]string{"username": c.creds["username"], "password": c.creds["password"]})
			h["Content-Type"] = "application/json"
		}
		raw, status, e := c.request(ctx, "POST", u, b, h)
		if e != nil {
			if status == 429 || status >= 500 {
				return e
			}
			continue
		}
		d := raw
		if raw["data"] != nil {
			d = obj(raw["data"])
		}
		token, _ := d["access_token"].(string)
		if token == "" {
			token, _ = d["accessToken"].(string)
		}
		if token == "" {
			continue
		}
		exp, _ := number(pick(d, "expires_in", "expiresIn"))
		if exp <= 0 {
			exp = 3600
		}
		c.token = token
		c.refreshToken, _ = d["refresh_token"].(string)
		if c.refreshToken == "" {
			c.refreshToken, _ = d["refreshToken"].(string)
		}
		c.authMode = mode
		c.expires = time.Now().Add(time.Duration(exp) * time.Second)
		return nil
	}
	return errors.New("vendor authentication refused")
}
func (c *Cloud) Sample(ctx context.Context, at time.Time) (Sample, error) {
	for attempt := 0; attempt < 2; attempt++ {
		if c.token == "" {
			if e := c.login(ctx); e != nil {
				return Sample{}, e
			}
		} else {
			refreshAt := c.expires
			if c.p.Source == "sigenergy" {
				refreshAt = refreshAt.Add(-5 * time.Minute)
			}
			if !time.Now().Before(refreshAt) {
				if e := c.refresh(ctx); e != nil {
					return Sample{}, e
				}
			}
		}
		u := "https://select.live/dashboard/hfdata/" + url.PathEscape(c.p.VendorSiteID)
		h := map[string]string{"Accept": "application/json"}
		if c.p.Source == "sigenergy" {
			h["Authorization"] = "Bearer " + c.token
			h["lang"] = "en_US"
			h["auth-client-id"] = "sigen"
			u = "https://api-" + c.p.Settings.Region + ".sigencloud.com/device/sigen/station/energyflow?id=" + url.QueryEscape(c.p.VendorSiteID)
			if c.authMode == "openapi" {
				u = "https://openapi-" + c.p.Settings.Region + ".sigencloud.com/openapi/systems/" + url.PathEscape(c.p.VendorSiteID) + "/energyFlow?systemId=" + url.QueryEscape(c.p.VendorSiteID)
			}
		}
		raw, status, e := c.request(ctx, "GET", u, nil, h)
		if status == 401 {
			c.token = ""
			return Sample{}, ErrSessionEvicted
		}
		if e != nil {
			return Sample{}, e
		}
		s, e := Normalize(c.p.Source, raw, at)
		if e == nil {
			c.latest = s
		}
		return s, e
	}
	return Sample{}, ErrSessionEvicted
}
func (c *Cloud) Harvest(time.Time) (map[string]any, bool) {
	return c.latest.Values, c.latest.Values != nil
}
func (c *Cloud) Close() error { c.client.CloseIdleConnections(); return nil }

type Integral struct {
	Total, Last float64
	At          time.Time
}

func (i *Integral) Update(v any, at time.Time) {
	n, ok := number(v)
	if !ok {
		return
	}
	if !i.At.IsZero() {
		i.Total += (n + i.Last) / 2 * at.Sub(i.At).Hours()
	}
	i.Last = n
	i.At = at
}

type froniusInv struct {
	Config Inverter
	Last   map[string]any
	Energy map[string]*Integral
}
type Fronius struct {
	history  []map[string]any
	sequence int
	inv      []froniusInv
	client   *http.Client
	baseline map[string]float64
	latest   map[string]any
}

func NewFronius(p Poller) *Fronius {
	f := &Fronius{client: &http.Client{Timeout: 5 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
	for _, i := range p.Settings.Inverters {
		f.inv = append(f.inv, froniusInv{Config: i, Energy: map[string]*Integral{}})
	}
	return f
}
func (f *Fronius) Sample(ctx context.Context, at time.Time) (Sample, error) {
	raw := map[string]any{}
	var first error
	for j := range f.inv {
		i := &f.inv[j]
		u := "http://" + i.Config.Host + "/solar_api/v1/GetPowerFlowRealtimeData.fcgi"
		req, e := http.NewRequestWithContext(ctx, "GET", u, nil)
		if e != nil {
			return Sample{}, e
		}
		res, e := f.client.Do(req)
		if e != nil {
			first = errors.New("Fronius request failed")
			continue
		}
		b, e := readLimited(res.Body, 2<<20)
		res.Body.Close()
		if e != nil || res.StatusCode != 200 {
			first = errors.New("Fronius request rejected")
			continue
		}
		var r map[string]any
		if json.Unmarshal(b, &r) != nil {
			first = errors.New("invalid Fronius JSON")
			continue
		}
		raw[i.Config.Host] = r
		if e := i.ingest(r, at); e != nil {
			first = e
		}
	}
	f.latest = f.values()
	if first != nil {
		return Sample{At: at, Values: f.latest, Raw: raw}, first
	}
	return Sample{At: at, Values: f.latest, Raw: raw}, nil
}
func (f *Fronius) values() map[string]any {
	v := map[string]any{}
	solar, battery, grid, local, remote, soc := 0.0, 0.0, 0.0, 0.0, 0.0, 0.0
	count := 0
	has := false
	for _, i := range f.inv {
		if i.Last == nil {
			continue
		}
		has = true
		n, _ := number(i.Last["solarW"])
		solar += n
		if i.Config.Master {
			local += n
			grid, _ = number(i.Last["gridW"])
		} else {
			remote += n
		}
		n, _ = number(i.Last["batteryW"])
		battery += n
		if n, ok := number(i.Last["batterySOC"]); ok {
			soc += n
			count++
		}
	}
	if !has {
		return nil
	}
	for _, i := range f.inv {
		if i.Last["faultCode"] != nil {
			v["faultCode"] = i.Last["faultCode"]
			v["faultTimestamp"] = i.Last["faultTimestamp"]
			break
		}
	}
	v["solarW"] = round(solar)
	v["solarLocalW"] = round(local)
	v["solarRemoteW"] = round(remote)
	v["batteryW"] = round(battery)
	v["gridW"] = round(grid)
	v["loadW"] = round(math.Max(0, solar+battery+grid))
	if count > 0 {
		v["batterySOC"] = round(soc/float64(count)*10) / 10
	}
	return v
}
func (f *Fronius) Harvest(at time.Time) (map[string]any, bool) {
	if f.latest == nil {
		return nil, false
	}
	tot := map[string]float64{"solarWh": 0, "batteryInWh": 0, "batteryOutWh": 0, "gridInWh": 0, "gridOutWh": 0}
	for _, i := range f.inv {
		for k, v := range i.Energy {
			tot[k] += v.Total
		}
	}
	if tot["solarWh"] <= 0 && tot["gridInWh"] <= 0 && tot["gridOutWh"] <= 0 {
		return nil, false
	}
	tot["loadWh"] = math.Max(0, tot["solarWh"]+tot["batteryOutWh"]+tot["gridInWh"]-tot["batteryInWh"]-tot["gridOutWh"])
	if f.baseline == nil {
		f.baseline = clone(tot)
		return nil, false
	}
	v := clone(f.latest)
	for k, n := range tot {
		delta := round(n - f.baseline[k])
		v[k+"Interval"] = delta
		f.baseline[k] += delta
	}
	row := clone(v)
	f.sequence++
	row["timestamp"] = at.UTC().Format(time.RFC3339Nano)
	row["sequence"] = f.sequence
	f.history = append(f.history, row)
	if len(f.history) > 20 {
		f.history = append([]map[string]any(nil), f.history[len(f.history)-20:]...)
	}
	return v, true
}

// Inspector is called by the collection goroutine; the runtime publishes a detached
// copy so HTTP/SSE never reads mutable integration state concurrently.
func (f *Fronius) Inspector(at time.Time) map[string]any {
	devices := []map[string]any{}
	faults := []map[string]any{}
	for _, i := range f.inv {
		energy := map[string]any{}
		for k, integral := range i.Energy {
			energy[k] = integral.Total
		}
		energy["loadWh"] = nil
		device := map[string]any{"ip": i.Config.Host, "hostname": i.Config.Host, "name": i.Config.Host, "isMaster": i.Config.Master, "energyCounters": energy}
		// Power-flow reads do not provide device identity/discovery metadata. Do not
		// manufacture serial numbers or advertise unqueried battery/meter information.
		if i.Last["faultCode"] != nil {
			device["faultCode"] = i.Last["faultCode"]
			faults = append(faults, map[string]any{"ip": i.Config.Host, "faultCode": i.Last["faultCode"], "timestamp": i.Last["faultTimestamp"]})
		}
		devices = append(devices, device)
	}
	values := f.latest
	metrics := map[string]any{"timestamp": at.UTC().Format(time.RFC3339Nano), "site": map[string]any{
		"solar":   map[string]any{"powerW": values["solarW"]},
		"battery": map[string]any{"powerW": values["batteryW"], "soc": values["batterySOC"]},
		"grid":    map[string]any{"powerW": values["gridW"]},
		"load":    map[string]any{"powerW": values["loadW"]},
	}}
	history := append([]map[string]any{}, f.history...)
	return map[string]any{"site": map[string]any{"devices": devices, "siteMetrics": metrics, "hasFault": len(faults) > 0, "faults": faults}, "latestSiteMetrics": metrics, "minutely": history}
}
func (f *Fronius) Close() error { f.client.CloseIdleConnections(); return nil }

func (i *froniusInv) ingest(r map[string]any, at time.Time) error {
	data := obj(obj(r["Body"])["Data"])
	site := obj(data["Site"])
	if site == nil {
		return errors.New("missing Fronius Site")
	}
	v := map[string]any{"solarW": scale(site["P_PV"], 1, true), "batteryW": scale(site["P_Akku"], 1, true), "gridW": scale(site["P_Grid"], 1, true)}
	invs := obj(data["Inverters"])
	keys := []string{}
	for k := range invs {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	if len(keys) > 0 {
		v["batterySOC"] = pick(obj(invs[keys[0]]), "SOC")
	}
	if len(keys) > 0 {
		status := obj(obj(invs[keys[0]])["DeviceStatus"])["StatusCode"]
		if n, ok := number(status); ok && n != 0 && n != 7 {
			v["faultCode"] = n
			v["faultTimestamp"] = at.Format("2006-01-02T15:04:05-07:00")
		}
	}
	i.Last = v
	flows := map[string]any{"solarWh": v["solarW"]}
	if i.Config.Battery {
		if n, ok := number(v["batteryW"]); ok {
			flows["batteryInWh"] = math.Max(-n, 0)
			flows["batteryOutWh"] = math.Max(n, 0)
		}
	}
	if i.Config.Master {
		if n, ok := number(v["gridW"]); ok {
			flows["gridInWh"] = math.Max(n, 0)
			flows["gridOutWh"] = math.Max(-n, 0)
		}
	}
	for k, v := range flows {
		if i.Energy[k] == nil {
			i.Energy[k] = &Integral{}
		}
		i.Energy[k].Update(v, at)
	}
	return nil
}

// Selectronic currently uses JavaScript Number coercion. Preserve it for replay,
// including the suspected empty-string/boolean defect tracked in docs/trial.md.
func selectNumber(v any) any {
	if v == nil {
		return nil
	}
	switch x := v.(type) {
	case bool:
		if x {
			return float64(1)
		}
		return float64(0)
	case string:
		if strings.TrimSpace(x) == "" {
			return float64(0)
		}
	case []any:
		if len(x) == 0 {
			return float64(0)
		}
		if len(x) == 1 {
			return selectNumber(x[0])
		}
	}
	return v
}

func (c *Cloud) refresh(ctx context.Context) error {
	if c.authMode != "legacy" || c.refreshToken == "" {
		return c.login(ctx)
	}
	sum := sha256.Sum256([]byte("liveone:" + c.creds["username"] + ":" + c.p.Settings.Region))
	form := url.Values{"grant_type": {"refresh_token"}, "refresh_token": {c.refreshToken}, "userDeviceId": {hex.EncodeToString(sum[:16])}}
	raw, _, e := c.request(ctx, "POST", "https://api-"+c.p.Settings.Region+".sigencloud.com/auth/oauth/token", []byte(form.Encode()), map[string]string{"Content-Type": "application/x-www-form-urlencoded", "Authorization": "Basic " + base64.StdEncoding.EncodeToString([]byte("sigen:sigen"))})
	if e != nil {
		return c.login(ctx)
	}
	d := raw
	if raw["data"] != nil {
		d = obj(raw["data"])
	}
	token, _ := d["access_token"].(string)
	if token == "" {
		token, _ = d["accessToken"].(string)
	}
	if token == "" {
		return c.login(ctx)
	}
	c.token = token
	if refresh, ok := d["refresh_token"].(string); ok && refresh != "" {
		c.refreshToken = refresh
	}
	exp, _ := number(pick(d, "expires_in", "expiresIn"))
	if exp <= 0 {
		exp = 3600
	}
	c.expires = time.Now().Add(time.Duration(exp) * time.Second)
	return nil
}
