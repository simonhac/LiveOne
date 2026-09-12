package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"liveone/gousher/internal/gousher"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func run() error {
	path := flag.String("config", "", "trial operations JSON config")
	health := flag.Bool("health", false, "check persisted operations health without network access")
	once := flag.Bool("once", false, "one monitoring/comparison pass")
	check := flag.Bool("check", false, "validate configuration and token presence without network access")
	flag.Parse()
	f, err := os.Open(*path)
	if err != nil {
		return err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, 1<<20+1))
	if err != nil {
		return err
	}
	if len(data) > 1<<20 {
		return fmt.Errorf("config exceeds budget")
	}
	var cfg gousher.TrialOpsConfig
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&cfg); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return fmt.Errorf("trailing config data")
	}
	if *health {
		return gousher.CheckTrialOpsHealth(cfg.DataDir, time.Now())
	}
	ops, err := gousher.NewTrialOps(cfg)
	if err != nil {
		return err
	}
	if *check {
		return nil
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if *once {
		ctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
		defer cancel()
		return ops.Once(ctx)
	}
	return ops.Run(ctx)
}
func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
