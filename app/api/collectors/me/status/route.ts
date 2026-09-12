import { NextRequest } from "next/server";
import { collectorApi } from "@/lib/collectors/api";
export function POST(req: NextRequest) {
  return collectorApi(req, "status");
}
