package gousher

import (
	"crypto/tls"
	"errors"
	"net/http"
)

// ListenAndServe permits plain HTTP for existing loopback deployments, and never
// falls back to it when TLS was requested but certificate configuration is invalid.
func ListenAndServe(server *http.Server, certFile, keyFile string) error {
	if certFile == "" && keyFile == "" {
		return server.ListenAndServe()
	}
	if certFile == "" || keyFile == "" {
		return errors.New("both TLS certificate and key files are required")
	}
	server.TLSConfig = &tls.Config{MinVersion: tls.VersionTLS12}
	return server.ListenAndServeTLS(certFile, keyFile)
}
