package gousher

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"math/big"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

func TestControlAccessJWTValidatesSignatureClaimsAndPasskey(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	wrong, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	var reads atomic.Int32
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reads.Add(1)
		jsonResponse(w, 200, map[string]any{"keys": []any{map[string]any{"kty": "RSA", "alg": "RS256", "use": "sig", "kid": "key1", "n": base64.RawURLEncoding.EncodeToString(key.N.Bytes()), "e": base64.RawURLEncoding.EncodeToString(big.NewInt(int64(key.E)).Bytes())}}})
	}))
	defer server.Close()
	verifier, err := NewAccessVerifier(server.URL, "app", server.Client())
	if err != nil {
		t.Fatal(err)
	}
	sign := func(claims jwt.MapClaims, signer *rsa.PrivateKey, method jwt.SigningMethod) string {
		token := jwt.NewWithClaims(method, claims)
		token.Header["kid"] = "key1"
		var signingKey any = signer
		if method == jwt.SigningMethodHS256 {
			signingKey = []byte("secret")
		}
		signed, err := token.SignedString(signingKey)
		if err != nil {
			t.Fatal(err)
		}
		return signed
	}
	for _, tc := range []struct {
		name    string
		change  func(jwt.MapClaims)
		signer  *rsa.PrivateKey
		method  jwt.SigningMethod
		passkey string
		want    int
	}{
		{"valid", nil, key, jwt.SigningMethodRS256, "secret", 200},
		{"wrong issuer", func(c jwt.MapClaims) { c["iss"] = "https://evil.example" }, key, jwt.SigningMethodRS256, "secret", 401},
		{"wrong audience", func(c jwt.MapClaims) { c["aud"] = []string{"other"} }, key, jwt.SigningMethodRS256, "secret", 401},
		{"expired", func(c jwt.MapClaims) { c["exp"] = time.Now().Add(-time.Minute).Unix() }, key, jwt.SigningMethodRS256, "secret", 401},
		{"not yet valid", func(c jwt.MapClaims) { c["nbf"] = time.Now().Add(time.Hour).Unix() }, key, jwt.SigningMethodRS256, "secret", 401},
		{"no expiry", func(c jwt.MapClaims) { delete(c, "exp") }, key, jwt.SigningMethodRS256, "secret", 401},
		{"bad signature", nil, wrong, jwt.SigningMethodRS256, "secret", 401},
		{"algorithm confusion", nil, key, jwt.SigningMethodHS256, "secret", 401},
		{"wrong passkey", nil, key, jwt.SigningMethodRS256, "wrong", 401},
	} {
		t.Run(tc.name, func(t *testing.T) {
			claims := jwt.MapClaims{"iss": server.URL, "aud": []string{"other", "app"}, "exp": time.Now().Add(time.Hour).Unix()}
			if tc.change != nil {
				tc.change(claims)
			}
			target := &simulator{}
			s, err := OpenSupervisor(target, filepath.Join(t.TempDir(), "run.json"), 600)
			if err != nil {
				t.Fatal(err)
			}
			h := s.SimulatorHandlerWithAccess("site", "secret", verifier)
			req := httptest.NewRequest("POST", "/api/usher/control/site/run", strings.NewReader(`{"passkey":"`+tc.passkey+`","runtimeSec":60}`))
			req.Header.Set("Cf-Access-Jwt-Assertion", sign(claims, tc.signer, tc.method))
			w := httptest.NewRecorder()
			h.ServeHTTP(w, req)
			if w.Code != tc.want {
				t.Fatalf("HTTP %d want %d: %s", w.Code, tc.want, w.Body.String())
			}
			if tc.want != 200 && target.starts != 0 {
				t.Fatal("rejected token reached target")
			}
		})
	}
	if reads.Load() != 1 {
		t.Fatalf("valid cached signing key fetched %d times", reads.Load())
	}
	if err := verifier.Verify(context.Background(), ""); err == nil {
		t.Fatal("missing token accepted")
	}
}

func TestControlAccessJWKSFailureDoesNotAuthorize(t *testing.T) {
	for _, tc := range []struct {
		name    string
		handler http.HandlerFunc
	}{
		{"unavailable", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(503) }},
		{"malformed", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(`{"keys":`)) }},
		{"oversized", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(strings.Repeat(" ", 1<<20+1))) }},
		{"redirect", func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, "https://example.com", 302) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewTLSServer(tc.handler)
			defer server.Close()
			v, err := NewAccessVerifier(server.URL, "app", server.Client())
			if err != nil {
				t.Fatal(err)
			}
			key, err := rsa.GenerateKey(rand.Reader, 2048)
			if err != nil {
				t.Fatal(err)
			}
			token := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.MapClaims{"iss": server.URL, "aud": "app", "exp": time.Now().Add(time.Hour).Unix()})
			token.Header["kid"] = "key1"
			signed, err := token.SignedString(key)
			if err != nil {
				t.Fatal(err)
			}
			if err := v.Verify(context.Background(), signed); err == nil {
				t.Fatal("failed JWKS lookup authorized request")
			}
		})
	}
	for _, origin := range []string{"http://example.com", "https://example.com/path", "https://user:pass@example.com", ""} {
		if _, err := NewAccessVerifier(origin, "app", nil); err == nil {
			t.Errorf("accepted invalid origin %q", origin)
		}
	}
	if _, err := NewAccessVerifier("https://team.cloudflareaccess.com", "", nil); err == nil {
		t.Fatal("accepted missing audience")
	}
}

func TestControlAccessKeyRotationAndFetchCoalescing(t *testing.T) {
	first, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	second, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	var current atomic.Pointer[rsa.PrivateKey]
	current.Store(first)
	var reads atomic.Int32
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reads.Add(1)
		key := current.Load()
		kid := "first"
		if key == second {
			kid = "second"
		}
		jsonResponse(w, 200, map[string]any{"keys": []any{map[string]any{"kty": "RSA", "alg": "RS256", "use": "sig", "kid": kid, "n": base64.RawURLEncoding.EncodeToString(key.N.Bytes()), "e": "AQAB"}}})
	}))
	defer server.Close()
	v, err := NewAccessVerifier(server.URL, "app", server.Client())
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	v.now = func() time.Time { return now }
	sign := func(key *rsa.PrivateKey, kid string) string {
		token := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.MapClaims{"iss": server.URL, "aud": "app", "exp": now.Add(time.Hour).Unix()})
		token.Header["kid"] = kid
		signed, err := token.SignedString(key)
		if err != nil {
			t.Fatal(err)
		}
		return signed
	}
	oldToken := sign(first, "first")
	results := make(chan error, 20)
	for i := 0; i < 20; i++ {
		go func() { results <- v.Verify(context.Background(), oldToken) }()
	}
	for i := 0; i < 20; i++ {
		if err := <-results; err != nil {
			t.Fatal(err)
		}
	}
	if reads.Load() != 1 {
		t.Fatalf("concurrent requests made %d key fetches", reads.Load())
	}
	current.Store(second)
	newToken := sign(second, "second")
	if err := v.Verify(context.Background(), newToken); err == nil {
		t.Fatal("unknown key bypassed cooldown")
	}
	if reads.Load() != 1 {
		t.Fatal("unknown key caused immediate repeated fetch")
	}
	now = now.Add(31 * time.Second)
	if err := v.Verify(context.Background(), newToken); err != nil {
		t.Fatal("rotated key rejected", err)
	}
	if err := v.Verify(context.Background(), oldToken); err == nil {
		t.Fatal("retired key remained authorized after refresh")
	}
	if reads.Load() != 2 {
		t.Fatal("unexpected rotation fetch count")
	}
}

func TestControlAccessCancellationAndPartialConfigurationFailClosed(t *testing.T) {
	entered := make(chan struct{})
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { close(entered); <-r.Context().Done() }))
	defer server.Close()
	v, err := NewAccessVerifier(server.URL, "app", server.Client())
	if err != nil {
		t.Fatal(err)
	}
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	token := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.MapClaims{"iss": server.URL, "aud": "app", "exp": time.Now().Add(time.Hour).Unix()})
	token.Header["kid"] = "key1"
	signed, err := token.SignedString(key)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	result := make(chan error, 1)
	go func() { result <- v.Verify(ctx, signed) }()
	<-entered
	cancel()
	select {
	case err := <-result:
		if err == nil {
			t.Fatal("cancelled verification accepted")
		}
	case <-time.After(time.Second):
		t.Fatal("key lookup ignored cancellation")
	}
	t.Setenv("CF_ACCESS_TEAM_DOMAIN", "")
	t.Setenv("CF_ACCESS_AUD", "configured-audience")
	target := &simulator{}
	s, err := OpenSupervisor(target, filepath.Join(t.TempDir(), "run.json"), 600)
	if err != nil {
		t.Fatal(err)
	}
	for _, h := range []http.Handler{s.SimulatorHandler("site", "secret"), s.SimulatorHandlerWithAccess("site", "secret", nil)} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest("POST", "/api/usher/control/site/run", strings.NewReader(`{"passkey":"secret","runtimeSec":60}`)))
		if w.Code != 503 || target.starts != 0 {
			t.Fatal("incomplete Access configuration allowed a command")
		}
	}
}
