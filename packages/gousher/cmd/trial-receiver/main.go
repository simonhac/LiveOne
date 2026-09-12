package main

import (
	"flag"
	"liveone/gousher/internal/gousher"
	"log"
	"net/http"
	"os"
	"time"
)

func main() {
	dir := flag.String("data", "/data/receiver", "bounded capture directory")
	listen := flag.String("listen", ":8081", "listen address")
	flag.Parse()
	token := os.Getenv("GOUSHER_RECEIVER_TOKEN")
	if token == "" {
		log.Fatal("receiver token required")
	}
	h, e := gousher.Receiver(*dir, token, 128<<20)
	if e != nil {
		log.Fatal(e)
	}
	s := &http.Server{Addr: *listen, Handler: h, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 15 * time.Second, IdleTimeout: 60 * time.Second}
	log.Fatal(gousher.ListenAndServe(s, os.Getenv("GOUSHER_TLS_CERT_FILE"), os.Getenv("GOUSHER_TLS_KEY_FILE")))
}
