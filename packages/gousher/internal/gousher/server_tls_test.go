package gousher

import (
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestServerTLSRefusesPartialConfiguration(t *testing.T) {
	for _, pair := range [][2]string{{"cert.pem", ""}, {"", "key.pem"}} {
		err := ListenAndServe(&http.Server{Addr: "127.0.0.1:0"}, pair[0], pair[1])
		if err == nil || !strings.Contains(err.Error(), "both TLS") {
			t.Fatalf("invalid TLS config: %v", err)
		}
	}
}

func TestServerTLSUsesVerifiedCertificate(t *testing.T) {
	fixture := httptest.NewTLSServer(http.NotFoundHandler())
	cert := fixture.TLS.Certificates[0]
	fixture.Close()
	dir := t.TempDir()
	certFile, keyFile := filepath.Join(dir, "cert.pem"), filepath.Join(dir, "key.pem")
	key, err := x509.MarshalPKCS8PrivateKey(cert.PrivateKey)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(certFile, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: cert.Certificate[0]}), 0600); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(keyFile, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: key}), 0600); err != nil {
		t.Fatal(err)
	}
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := l.Addr().String()
	l.Close()
	server := &http.Server{Addr: address, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, "secure") })}
	done := make(chan error, 1)
	go func() { done <- ListenAndServe(server, certFile, keyFile) }()
	defer func() {
		server.Close()
		if err := <-done; !errors.Is(err, http.ErrServerClosed) {
			t.Error(err)
		}
	}()
	roots := x509.NewCertPool()
	roots.AppendCertsFromPEM(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: cert.Certificate[0]}))
	tr := &http.Transport{TLSClientConfig: &tls.Config{RootCAs: roots}}
	defer tr.CloseIdleConnections()
	client := &http.Client{Transport: tr, Timeout: time.Second}
	var response *http.Response
	for deadline := time.Now().Add(3 * time.Second); time.Now().Before(deadline); time.Sleep(10 * time.Millisecond) {
		response, err = client.Get("https://" + address)
		if err == nil {
			break
		}
	}
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.TLS == nil || response.TLS.Version < tls.VersionTLS12 || response.StatusCode != 200 {
		t.Fatal("TLS not established")
	}
}
