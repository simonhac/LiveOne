package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"liveone/gousher/internal/gousher"
	"log"
	"os"
	"time"
)

func read(path string) []gousher.Batch {
	f, e := os.Open(path)
	if e != nil {
		log.Fatal(e)
	}
	defer f.Close()
	scan := bufio.NewScanner(f)
	scan.Buffer(make([]byte, 65536), 2<<20)
	out := []gousher.Batch{}
	for scan.Scan() {
		var b gousher.Batch
		if e = json.Unmarshal(scan.Bytes(), &b); e != nil {
			log.Fatal(e)
		}
		if b.VendorSiteID == "" || b.MeasurementTime.IsZero() {
			log.Fatal("comparison inputs require vendor site identity and timestamp")
		}
		out = append(out, b)
		if len(out) > 50000 {
			log.Fatal("comparison input exceeds 50,000 samples; use a smaller window")
		}
	}
	if e = scan.Err(); e != nil {
		log.Fatal(e)
	}
	return out
}
func main() {
	reference := flag.String("reference", "", "baseline batches as JSONL")
	actual := flag.String("actual", "", "trial batches as JSONL")
	window := flag.Duration("window", 0, "maximum timestamp distance (0 for vendor timestamps)")
	dir := flag.String("summary-dir", "", "bounded daily summary store")
	flag.Parse()
	if *reference == "" || *actual == "" {
		log.Fatal("reference and actual files required")
	}
	r := gousher.CompareIndependent(read(*reference), read(*actual), *window)
	b, _ := json.MarshalIndent(r, "", "  ")
	fmt.Println(string(b))
	if *dir != "" {
		if e := gousher.SaveDailySummary(*dir, map[string]any{"at": time.Now().UTC(), "comparison": r, "window": window.String()}, time.Now().UTC()); e != nil {
			log.Fatal(e)
		}
	}
	if r.Mismatches > 0 {
		os.Exit(1)
	}
}
