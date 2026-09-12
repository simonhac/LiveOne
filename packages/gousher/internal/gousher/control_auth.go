package gousher

import (
	"context"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"errors"
	"math/big"
	"net/http"
	"net/url"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// AccessVerifier verifies the origin assertion, independently of the edge policy
// and per-device passkey. The configured issuer, never a token URL, selects JWKS.
// See https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/
type AccessVerifier struct {
	issuer, audience       string
	client                 *http.Client
	gate                   chan struct{}
	keys                   map[string]*rsa.PublicKey
	fetchedAt, lastAttempt time.Time
	now                    func() time.Time
}

func NewAccessVerifier(issuer, audience string, client *http.Client) (*AccessVerifier, error) {
	u, err := url.Parse(issuer)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || audience == "" {
		return nil, errors.New("Access requires an HTTPS team origin and audience")
	}
	c := http.Client{}
	if client != nil {
		c = *client
	}
	c.Timeout = 5 * time.Second
	c.CheckRedirect = func(*http.Request, []*http.Request) error { return errors.New("Access key redirects refused") }
	return &AccessVerifier{issuer: issuer, audience: audience, client: &c, gate: make(chan struct{}, 1), now: time.Now}, nil
}
func (v *AccessVerifier) Verify(ctx context.Context, assertion string) error {
	if assertion == "" || len(assertion) > 16384 {
		return errors.New("missing or oversized Access assertion")
	}
	_, err := jwt.Parse(assertion, func(token *jwt.Token) (any, error) {
		kid, ok := token.Header["kid"].(string)
		if !ok || kid == "" || len(kid) > 256 {
			return nil, errors.New("invalid Access key ID")
		}
		return v.key(ctx, kid)
	}, jwt.WithValidMethods([]string{"RS256"}), jwt.WithIssuer(v.issuer), jwt.WithAudience(v.audience), jwt.WithExpirationRequired(), jwt.WithTimeFunc(v.now))
	if err != nil {
		return errors.New("Access JWT rejected")
	}
	return nil
}
func (v *AccessVerifier) key(ctx context.Context, kid string) (*rsa.PublicKey, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	select {
	case v.gate <- struct{}{}:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	defer func() { <-v.gate }()
	now := v.now()
	if key := v.keys[kid]; key != nil && now.Sub(v.fetchedAt) < 10*time.Minute {
		return key, nil
	}
	// Unknown IDs must not turn unauthenticated traffic into unbounded JWKS fetches.
	if !v.lastAttempt.IsZero() && now.Sub(v.lastAttempt) < 30*time.Second {
		return nil, errors.New("Access keys unavailable")
	}
	v.lastAttempt = now
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, v.issuer+"/cdn-cgi/access/certs", nil)
	if err != nil {
		return nil, err
	}
	response, err := v.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, errors.New("Access keys unavailable")
	}
	data, err := readLimited(response.Body, 1<<20)
	if err != nil {
		return nil, err
	}
	var document struct {
		Keys []struct{ Kty, Alg, Use, Kid, N, E string }
	}
	if json.Unmarshal(data, &document) != nil || len(document.Keys) == 0 || len(document.Keys) > 16 {
		return nil, errors.New("invalid Access key set")
	}
	keys := map[string]*rsa.PublicKey{}
	for _, jwk := range document.Keys {
		if jwk.Kty != "RSA" || jwk.Alg != "RS256" || jwk.Use != "sig" || jwk.Kid == "" {
			continue
		}
		n, ne := base64.RawURLEncoding.DecodeString(jwk.N)
		e, ee := base64.RawURLEncoding.DecodeString(jwk.E)
		if ne != nil || ee != nil || len(n) < 256 || len(n) > 512 || len(e) == 0 || len(e) > 4 {
			continue
		}
		exponent := new(big.Int).SetBytes(e).Int64()
		if exponent < 3 || exponent > 2147483647 || exponent%2 == 0 {
			continue
		}
		if keys[jwk.Kid] != nil {
			return nil, errors.New("duplicate Access key ID")
		}
		keys[jwk.Kid] = &rsa.PublicKey{N: new(big.Int).SetBytes(n), E: int(exponent)}
	}
	if len(keys) == 0 {
		return nil, errors.New("no usable Access keys")
	}
	v.keys = keys
	v.fetchedAt = now
	if key := keys[kid]; key != nil {
		return key, nil
	}
	return nil, errors.New("unknown Access key")
}
