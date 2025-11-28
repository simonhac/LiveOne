import { describe, it, expect, beforeAll } from "@jest/globals";

// Load environment variables from .env.local for testing
import * as dotenv from "dotenv";
import * as path from "path";
dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

const API_URL = "http://localhost:3000/api/push/fusher";

// Test credentials - must match what's stored in Clerk
const VALID_API_KEY = "fr_abcd-1234-efgh-5678";
const INVALID_API_KEY = "fr_invalid-key";

describe("Fusher Push API Integration Tests", () => {
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

  describe("Authentication", () => {
    it("should authenticate successfully with valid API key", async () => {
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
      expect(data.systemId).toBe(5);
      expect(data.displayName).toBe("Kinkora Fronius");
    });

    it("should reject invalid API key with 401", async () => {
      const response = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiKey: INVALID_API_KEY,
          action: "test",
        }),
      });

      expect(response.status).toBe(401);

      const data = await response.json();
      expect(data.error).toBe("Invalid API key");
    });

    it("should return 404 for unknown siteId", async () => {
      const response = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiKey: VALID_API_KEY,
          siteId: "unknown-site",
          action: "test",
        }),
      });

      expect(response.status).toBe(404);

      const data = await response.json();
      expect(data.error).toBe("System not found");
    });

    it("should authenticate with explicit siteId", async () => {
      const response = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiKey: VALID_API_KEY,
          siteId: "kinkora",
          action: "test",
        }),
      });

      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.systemId).toBe(5);
    });
  });

  describe("Request Validation", () => {
    it("should require apiKey field", async () => {
      const response = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "test",
        }),
      });

      expect(response.status).toBe(400);

      const data = await response.json();
      expect(data.error).toBe("Missing apiKey");
    });

    it("should require action field", async () => {
      const response = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiKey: VALID_API_KEY,
        }),
      });

      expect(response.status).toBe(400);

      const data = await response.json();
      expect(data.error).toContain("Missing or invalid action");
    });

    it("should reject invalid action values", async () => {
      const response = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiKey: VALID_API_KEY,
          action: "invalid",
        }),
      });

      expect(response.status).toBe(400);

      const data = await response.json();
      expect(data.error).toContain("Missing or invalid action");
    });

    it("should require timestamp for store action", async () => {
      const response = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiKey: VALID_API_KEY,
          action: "store",
          sequence: "test-123",
        }),
      });

      expect(response.status).toBe(400);

      const data = await response.json();
      expect(data.error).toContain("Missing timestamp");
    });

    it("should require sequence for store action", async () => {
      const response = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiKey: VALID_API_KEY,
          action: "store",
          timestamp: new Date().toISOString(),
        }),
      });

      expect(response.status).toBe(400);

      const data = await response.json();
      expect(data.error).toContain("Missing sequence");
    });
  });

  describe("GET Endpoint", () => {
    it("should return endpoint documentation", async () => {
      const response = await fetch(API_URL);

      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.status).toBe("ready");
      expect(data.endpoint).toBe("/api/push/fusher");
      expect(data.method).toBe("POST");
      expect(data.requiredFields.always).toContain("apiKey");
      expect(data.requiredFields.always).toContain("action");
      expect(data.requiredFields.optional).toContain("siteId");
    });
  });
});
