import { NextResponse } from "next/server";

// Serves the Tesla Fleet API partner public key. Tesla fetches this during partner
// registration and (for signed commands) virtual-key enrollment, from the well-known
// URL /.well-known/appspecific/com.tesla.3p.public-key.pem — next.config.js rewrites
// that path here. The key lives in TESLA_PUBLIC_KEY_PEM (single line, escaped \n, as
// scripts/utils/tesla-generate-keypair.sh emits); we restore the real newlines so the
// served body is a valid PEM. The path is allow-listed in lib/route-matchers.ts so Clerk
// middleware doesn't gate it.
export const dynamic = "force-dynamic";

export function GET() {
  const raw = process.env.TESLA_PUBLIC_KEY_PEM;
  if (!raw) {
    return new NextResponse("Tesla public key not configured", { status: 404 });
  }

  const pem = raw.replace(/\\n/g, "\n").trim() + "\n";

  return new NextResponse(pem, {
    status: 200,
    headers: {
      "Content-Type": "application/x-pem-file",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
