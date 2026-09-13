package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"liveone/gousher/internal/gousher"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func run() error {
	path := flag.String("config", "", "watchdog JSON config")
	once := flag.Bool("once", false, "check evidence once and stop the assignment if needed")
	check := flag.Bool("check", false, "validate config and secret presence without network access")
	flag.Parse()
	f, err := os.Open(*path)
	if err != nil {
		return err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, (1<<20)+1))
	if err != nil {
		return err
	}
	if len(data) > 1<<20 {
		return errors.New("watchdog config too large")
	}
	var cfg gousher.TrialWatchdogConfig
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	if err = d.Decode(&cfg); err != nil {
		return err
	}
	var extra any
	if d.Decode(&extra) != io.EOF {
		return errors.New("trailing config data")
	}
	watchdog, err := gousher.NewTrialWatchdog(cfg)
	if err != nil {
		return err
	}
	if *check {
		return nil
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if *once {
		return watchdog.Once(ctx, time.Now())
	}
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		if ctx.Err() != nil {
			return nil
		}
		if err := watchdog.Once(ctx, time.Now()); err != nil {
			log.Print(err)
		}
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		}
	}
}
func main() {
	if err := run(); err != nil {
		log.Print(err)
		os.Exit(1)
	}
}
