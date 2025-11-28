import { describe, it, expect, beforeAll } from "@jest/globals";

// Load environment variables from .env.local for testing
import * as dotenv from "dotenv";
import * as path from "path";
dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

// Test the backward-compatible /api/push/fronius endpoint
const API_URL = "http://localhost:3000/api/push/fronius";

// Test credentials - must match what's stored in Clerk
const VALID_API_KEY = "fr_abcd-1234-efgh-5678";

describe("Fronius Backward Compatibility Tests", () => {
  beforeAll(async () => {
    // Check if dev server is running
    try {
      const response = await fetch("http://localhost:3000/api/health");
      if (!response.ok) {
        throw new Error(
          "Dev server not responding properly. Please run: npm run dev",
        );
      }
    } catch (error) {
      throw new Error(
        "Dev server is not running. Please start it with: npm run dev",
      );
    }
  });

  describe("Backward Compatibility Alias", () => {
    it("should authenticate via /api/push/fronius alias", async () => {
      const response = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiKey: VALID_API_KEY,
          action: "test",
        }),
      });

      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.action).toBe("test");
      expect(data.message).toBe("Authentication successful");
    });

    it("should return endpoint documentation via GET on fronius alias", async () => {
      const response = await fetch(API_URL);

      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.status).toBe("ready");
      // Note: The endpoint reported is the canonical /api/push/fusher
      expect(data.endpoint).toBe("/api/push/fusher");
      expect(data.method).toBe("POST");
    });
  });
});
