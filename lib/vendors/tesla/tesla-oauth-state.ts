/**
 * Shared state for the Tesla Fleet API OAuth flow.
 *
 * The connect route stores the PKCE code_verifier here (in KV, keyed by an opaque
 * `state`) so it never reaches the browser; the callback route reads it back when Tesla
 * redirects to /api/auth/tesla/callback. Kept out of the route files because Next.js App
 * Router route modules may only export HTTP handlers + segment config.
 */

import { kvKey } from "@/lib/kv";

// How long the user has to complete the Tesla login, in seconds.
export const TESLA_OAUTH_STATE_TTL_SECONDS = 15 * 60;

export interface TeslaOAuthState {
  userId: string;
  codeVerifier: string;
}

/**
 * KV key for a pending OAuth handshake, namespaced per environment.
 * The `state` round-trips through Tesla and comes back on the callback redirect.
 */
export function teslaOAuthStateKey(state: string): string {
  return kvKey(`tesla:oauth:${state}`);
}
