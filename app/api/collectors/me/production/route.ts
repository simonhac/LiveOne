import { NextRequest } from "next/server";
import { collectorApi } from "@/lib/collectors/api";
export function GET(req: NextRequest) {
  return collectorApi(req, "production");
}
