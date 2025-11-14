import { NextResponse } from "next/server";
import { getUserIdByUsername } from "@/lib/user-cache";

export async function GET() {
  const username = "simon";
  const iterations = 50;
  const times: number[] = [];

  // Run lookups
  for (let i = 0; i < iterations; i++) {
    const start = Date.now();
    await getUserIdByUsername(username);
    const duration = Date.now() - start;
    times.push(duration);
  }

  // Calculate statistics
  const min = Math.min(...times);
  const max = Math.max(...times);
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  const sorted = [...times].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const first = times[0];

  return NextResponse.json({
    count: iterations,
    first,
    min,
    max,
    median,
    avg: Math.round(avg * 10) / 10,
  });
}
