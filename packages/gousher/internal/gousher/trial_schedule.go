package gousher

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"
)

type dailyCursor struct {
	Fingerprint string    `json:"fingerprint"`
	NextDay     time.Time `json:"nextDay"`
	ReviewDays  int       `json:"reviewDays"`
	CleanDays   int       `json:"consecutiveCleanDays"`
}

func loadOpsState(path string, out any) error {
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
		return errors.New("null operations state")
	}
	if len(data) > 1<<20 {
		return errors.New("operations state too large")
	}
	return json.Unmarshal(data, out)
}
func saveOpsState(path string, state any) error {
	data, err := json.Marshal(state)
	if err != nil {
		return err
	}
	if len(data) > 1<<20 {
		return errors.New("operations state too large")
	}
	return AtomicWrite(path, data)
}
func (o *TrialOps) DailyOnce(ctx context.Context, now time.Time) error {
	if err := os.MkdirAll(o.cfg.DataDir, 0700); err != nil {
		return err
	}
	unlock, err := lockInstance(filepath.Join(o.cfg.DataDir, "daily.lock"))
	if err != nil {
		return err
	}
	defer unlock()
	path := filepath.Join(o.cfg.DataDir, "daily-state.json")
	state := map[string]dailyCursor{}
	if err := loadOpsState(path, &state); err != nil {
		return err
	}
	active := map[string]bool{}
	for _, p := range o.cfg.Pollers {
		active[opsKey(p)] = true
	}
	for key := range state {
		if !active[key] {
			delete(state, key)
		}
	}
	var problems []error
	for _, p := range o.cfg.Pollers {
		key := opsKey(p)
		cursor, ok := state[key]
		if !ok {
			first := p.From.UTC().Truncate(24 * time.Hour)
			if first.Before(p.From) {
				first = first.Add(24 * time.Hour)
			}
			cursor = dailyCursor{Fingerprint: opsFingerprint(p), NextDay: first}
		}
		if cursor.Fingerprint != opsFingerprint(p) {
			problems = append(problems, errors.New("daily configuration changed without new revision"))
			continue
		}
		// One day per assignment per pass; missing days catch up without blocking monitoring.
		if !cursor.NextDay.Add(26 * time.Hour).After(now) {
			err := o.CompareDay(ctx, p, cursor.NextDay)
			var issue *ComparisonIssue
			if err != nil && !errors.As(err, &issue) {
				problems = append(problems, fmt.Errorf("poller %s: %w", p.ID, err))
				continue
			}
			if issue != nil {
				cursor.ReviewDays++
				cursor.CleanDays = 0
			} else {
				cursor.CleanDays++
			}
			cursor.NextDay = cursor.NextDay.Add(24 * time.Hour)
			state[key] = cursor
			if err := saveOpsState(path, state); err != nil {
				return err
			}
		}
		if cursor.ReviewDays > 0 {
			problems = append(problems, fmt.Errorf("poller %s: %d comparison days require review", p.ID, cursor.ReviewDays))
		}
	}
	return errors.Join(problems...)
}
func (o *TrialOps) health(kind string, err error) error {
	state := map[string]any{"at": time.Now().UTC(), "ok": err == nil}
	if err != nil {
		state["error"] = err.Error()
	}
	return saveOpsState(filepath.Join(o.cfg.DataDir, kind+"-health.json"), state)
}

// Monitor and comparison loops are independent. Neither a slow export nor a
// nonclean day can delay shutdown monitoring. Health files are for external supervision.
func (o *TrialOps) Run(ctx context.Context) error {
	if err := os.MkdirAll(o.cfg.DataDir, 0700); err != nil {
		return err
	}
	unlock, err := lockInstance(filepath.Join(o.cfg.DataDir, "ops.lock"))
	if err != nil {
		return err
	}
	defer unlock()
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	failures := make(chan error, 2)
	var wg sync.WaitGroup
	loop := func(kind string, interval, budget time.Duration, job func(context.Context, time.Time) error) {
		defer wg.Done()
		timer := time.NewTicker(interval)
		defer timer.Stop()
		for {
			if ctx.Err() != nil {
				return
			}
			c, stop := context.WithTimeout(ctx, budget)
			err := job(c, time.Now())
			if err != nil {
				log.Printf("trial %s unhealthy: %v", kind, err)
			}
			stop()
			if e := o.health(kind, err); e != nil {
				failures <- e
				cancel()
				return
			}
			select {
			case <-ctx.Done():
				return
			case <-timer.C:
			}
		}
	}
	wg.Add(2)
	go loop("monitor", 30*time.Second, 5*time.Minute, o.MonitorOnce)
	go loop("comparison", 10*time.Minute, 8*time.Minute, o.DailyOnce)
	wg.Wait()
	close(failures)
	var errs []error
	for err := range failures {
		errs = append(errs, err)
	}
	return errors.Join(errs...)
}
func (o *TrialOps) Once(ctx context.Context) error {
	var wg sync.WaitGroup
	errs := make(chan error, 2)
	for _, job := range []struct {
		kind string
		fn   func(context.Context, time.Time) error
	}{{"monitor", o.MonitorOnce}, {"comparison", o.DailyOnce}} {
		wg.Add(1)
		go func(kind string, fn func(context.Context, time.Time) error) {
			defer wg.Done()
			err := fn(ctx, time.Now())
			errs <- errors.Join(err, o.health(kind, err))
		}(job.kind, job.fn)
	}
	wg.Wait()
	close(errs)
	var all []error
	for err := range errs {
		all = append(all, err)
	}
	return errors.Join(all...)
}

// CheckTrialOpsHealth is suitable for a separate service watchdog. Successful
// process liveness alone says nothing about current monitoring coverage.
func CheckTrialOpsHealth(dir string, now time.Time) error {
	for kind, age := range map[string]time.Duration{"monitor": 2 * time.Minute, "comparison": 20 * time.Minute} {
		var health struct {
			At    time.Time
			OK    *bool
			Error string
		}
		if err := loadOpsState(filepath.Join(dir, kind+"-health.json"), &health); err != nil {
			return err
		}
		if health.OK == nil || !*health.OK || health.At.IsZero() || now.Sub(health.At) > age || health.At.After(now.Add(time.Minute)) {
			return fmt.Errorf("%s health missing, stale or unhealthy", kind)
		}
	}
	return nil
}
