"use client";

import { QueryClientProvider } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { Toaster } from "sonner";
import { getQueryClient } from "./get-query-client";

/**
 * App-wide React Query provider. Mounted in the root layout (inside ClerkProvider)
 * so the QueryClient is global — every route shares one cache, which is what makes
 * cross-route `invalidateQueries` work.
 */
export default function Providers({ children }: { children: React.ReactNode }) {
  // getQueryClient() returns the browser singleton (or a fresh server client during
  // SSR of the provider itself). No useState needed: there is no Suspense boundary
  // above this that could discard a useState-held client on a suspended first render.
  const queryClient = getQueryClient();

  return (
    <QueryClientProvider client={queryClient}>
      {children}
      <Toaster theme="dark" position="bottom-right" richColors closeButton />
      {process.env.NODE_ENV === "development" && (
        <ReactQueryDevtools
          initialIsOpen={false}
          buttonPosition="bottom-left"
        />
      )}
    </QueryClientProvider>
  );
}
