package gousher

import "time"

var readBounds = []float64{.005, .01, .025, .05, .1, .25, .5, 1, 2.5, 5, 10, 30}

type readMetrics struct {
	Started time.Time
	Count   uint64
	Failed  uint64
	Seconds float64
	Buckets []uint64
}

func (r *Runtime) recordRead(poller string, started time.Time, elapsed time.Duration, failed bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.readMetrics == nil {
		r.readMetrics = map[string]readMetrics{}
	}
	m := r.readMetrics[poller]
	if m.Buckets == nil {
		m.Started = started
		m.Buckets = make([]uint64, len(readBounds)+1)
	}
	m.Count++
	if failed {
		m.Failed++
	}
	seconds := elapsed.Seconds()
	m.Seconds += seconds
	bucket := len(readBounds)
	for i, bound := range readBounds {
		if seconds <= bound {
			bucket = i
			break
		}
	}
	m.Buckets[bucket]++
	r.readMetrics[poller] = m
}
func (r *Runtime) readMetricsSnapshot() map[string]readMetrics {
	r.mu.Lock()
	defer r.mu.Unlock()
	return clone(r.readMetrics)
}
