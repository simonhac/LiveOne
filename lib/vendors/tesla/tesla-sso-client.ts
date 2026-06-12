/**
 * Tesla Owner API SSO Client
 *
 * Implements the legacy `ownerapi` OAuth flow (auth.tesla.com) used to mint tokens
 * that work against the Owner API (`owner-api.teslamotors.com`). Unlike the Fleet API
 * client (`tesla-client.ts`), this requires NO client secret and NO env vars — it uses
 * Tesla's first-party `ownerapi` client, which only ever redirects to the fixed
 * `https://auth.tesla.com/void/callback` page.
 *
 * Because the redirect lands on Tesla's own void/callback page (not our app), onboarding
 * is "redirect + paste-back": the user logs in on Tesla's page, lands on a blank
 * "Page Not Found", and pastes that URL back into our app. We parse the `code` from it
 * and exchange it here.
 *
 * Flow reference: https://tesla-api.timdorr.com/api-basics/authentication
 */

import type { TeslaTokens } from "./types";
import { generatePKCE } from "./tesla-client";

// Tesla SSO endpoints (shared with Fleet, but using the legacy `ownerapi` client)
const AUTH_BASE_URL = "https://auth.tesla.com";
const AUTHORIZE_URL = `${AUTH_BASE_URL}/oauth2/v3/authorize`;
const TOKEN_URL = `${AUTH_BASE_URL}/oauth2/v3/token`;

// The legacy Owner API OAuth client. This is fixed by Tesla.
const OWNERAPI_CLIENT_ID = "ownerapi";
// Tesla does NOT allow a custom redirect URI for `ownerapi` — it is always this.
export const OWNERAPI_REDIRECT_URI = "https://auth.tesla.com/void/callback";
const OWNERAPI_SCOPES = "openid email offline_access";

// Re-export so callers (routes) can generate PKCE without importing the Fleet client.
export { generatePKCE };

/**
 * Build the Tesla SSO authorization URL for the `ownerapi` client.
 *
 * @param state - Opaque CSRF/lookup token; round-trips back in the void/callback URL.
 * @param codeChallenge - S256 PKCE challenge (base64url of SHA-256(verifier)).
 * @param loginHint - Optional email to prefill Tesla's login form.
 */
export function getOwnerApiAuthorizationUrl(
  state: string,
  codeChallenge: string,
  loginHint?: string,
): string {
  const params = new URLSearchParams({
    client_id: OWNERAPI_CLIENT_ID,
    redirect_uri: OWNERAPI_REDIRECT_URI,
    response_type: "code",
    scope: OWNERAPI_SCOPES,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
  });
  if (loginHint) {
    params.set("login_hint", loginHint);
  }
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

/**
 * Exchange an authorization code (parsed from the pasted void/callback URL) for tokens.
 */
export async function exchangeCodeForOwnerApiTokens(
  code: string,
  codeVerifier: string,
): Promise<TeslaTokens> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: OWNERAPI_CLIENT_ID,
      code,
      code_verifier: codeVerifier,
      redirect_uri: OWNERAPI_REDIRECT_URI,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(
      "[Tesla SSO] Token exchange failed:",
      response.status,
      errorText,
    );
    throw new Error(
      `Tesla token exchange failed: ${response.status} - ${describeTokenError(errorText)}`,
    );
  }

  return (await response.json()) as TeslaTokens;
}

/**
 * Refresh an Owner API access token using the stored SSO refresh token.
 * No client secret required for the `ownerapi` client.
 */
export async function refreshOwnerApiTokens(
  refreshToken: string,
): Promise<TeslaTokens> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: OWNERAPI_CLIENT_ID,
      refresh_token: refreshToken,
      scope: OWNERAPI_SCOPES,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(
      "[Tesla SSO] Token refresh failed:",
      response.status,
      errorText,
    );
    throw new Error(
      `Tesla token refresh failed: ${response.status} - ${describeTokenError(errorText)}`,
    );
  }

  return (await response.json()) as TeslaTokens;
}

/**
 * Parse the authorization `code` and `state` out of the URL the user pasted back from
 * Tesla's void/callback page. Validates the host so we never parse an arbitrary URL.
 *
 * @throws Error with a user-friendly message if the URL is not a valid Tesla callback.
 */
export function parseTeslaCallbackUrl(input: string): {
  code: string;
  state: string;
} {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error(
      "That doesn't look like a URL. Copy the full address bar from the Tesla page after logging in.",
    );
  }

  if (url.hostname !== "auth.tesla.com") {
    throw new Error(
      "Expected a Tesla URL (auth.tesla.com). Make sure you copied the address after logging in.",
    );
  }

  const error = url.searchParams.get("error");
  if (error) {
    throw new Error(`Tesla returned an error: ${error}`);
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    throw new Error(
      "The pasted URL is missing the authorization code. Copy the full address after the 'Page Not Found' appears.",
    );
  }

  return { code, state };
}

function describeTokenError(errorText: string): string {
  try {
    const parsed = JSON.parse(errorText);
    return parsed.error_description || parsed.error || errorText;
  } catch {
    return errorText;
  }
}
