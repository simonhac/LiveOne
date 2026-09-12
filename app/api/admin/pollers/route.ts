import { NextRequest } from "next/server";
import { adminPollers } from "@/lib/collectors/api";

export function GET(request: NextRequest) {
  return adminPollers(request);
}
export function POST(request: NextRequest) {
  return adminPollers(request);
}
