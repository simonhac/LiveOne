package main

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"liveone/gousher/internal/gousher"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	config := flag.String("config", "bootstrap.yaml", "bootstrap settings (JSON-compatible YAML)")
	replay := flag.String("replay", "", "replay a JSONL fixture without network access")
	output := flag.String("replay-batches", "", "write computed replay batches as credential-free JSONL")
	flag.Parse()
	if *replay != "" {
		f, e := os.Open(*replay)
		if e != nil {
			log.Fatal(e)
		}
		defer f.Close()
		var emit func(gousher.Batch) error
		if *output != "" {
			out, err := os.OpenFile(*output, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
			if err != nil {
				log.Fatal(err)
			}
			defer out.Close()
			encoder := json.NewEncoder(out)
			emit = func(b gousher.Batch) error { return encoder.Encode(b) }
		}
		report, e := gousher.ReplayBatches(f, emit)
		if e != nil {
			log.Fatal(e)
		}
		b, _ := json.MarshalIndent(report, "", "  ")
		fmt.Println(string(b))
		if report.Mismatches > 0 {
			os.Exit(1)
		}
		return
	}
	b, e := os.ReadFile(*config)
	if e != nil {
		log.Fatal(e)
	}
	var boot gousher.Bootstrap
	if e = json.Unmarshal(b, &boot); e != nil {
		log.Fatal("bootstrap must use JSON-compatible YAML: ", e)
	}
	key, e := hex.DecodeString(os.Getenv("GOUSHER_INSTANCE_KEY"))
	if e != nil {
		log.Fatal("invalid instance key")
	}
	r, e := gousher.OpenRuntime(boot, os.Getenv("GOUSHER_COLLECTOR_TOKEN"), os.Getenv("GOUSHER_RECEIVER_TOKEN"), os.Getenv("GOUSHER_INSPECTOR_TOKEN"), key)
	if e != nil {
		log.Fatal(e)
	}
	if e = boot.Validate(); e != nil {
		log.Fatal(e)
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	server := &http.Server{Addr: boot.Listen, Handler: r.Handler(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, IdleTimeout: 60 * time.Second}
	telemetryDone := make(chan struct{})
	go func() {
		defer close(telemetryDone)
		r.RunTelemetry(ctx, os.Getenv("GOUSHER_METRICS_ENDPOINT"), os.Getenv("GOUSHER_METRICS_TOKEN"), func(err error) {
			if err != nil {
				log.Print(err)
			}
		})
	}()
	serverErrors := make(chan error, 1)
	go func() {
		if e := server.ListenAndServe(); e != nil && e != http.ErrServerClosed {
			log.Printf("inspector stopped: %v", e)
			serverErrors <- e
			cancel()
		}
	}()
	if e = r.Run(ctx); e != nil {
		log.Print(e)
		cancel()
	}
	cancel()
	<-telemetryDone
	shutdown, done := context.WithTimeout(context.Background(), 10*time.Second)
	defer done()
	_ = server.Shutdown(shutdown)
	select {
	case <-serverErrors:
		os.Exit(1)
	default:
	}
	if e != nil {
		os.Exit(1)
	}
}
