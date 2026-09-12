import { handleTrialExport } from "@/core/trial-monitor";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export function GET(req: Request) {
  return handleTrialExport(req);
}
