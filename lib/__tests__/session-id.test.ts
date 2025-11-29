import { describe, it, expect, beforeEach } from "@jest/globals";
import { SessionId, getNextSessionId, formatSessionId } from "../session-id";

describe("SessionId", () => {
  beforeEach(() => {
    // Clear the singleton before each test
    SessionId.clearInstance();
  });

  describe("getInstance", () => {
    it("should return the same instance on multiple calls", () => {
      const instance1 = SessionId.getInstance();
      const instance2 = SessionId.getInstance();
      expect(instance1).toBe(instance2);
    });

    it("should create a new instance after clearing", () => {
      const instance1 = SessionId.getInstance();
      const prefix1 = instance1.getPrefix();

      SessionId.clearInstance();

      const instance2 = SessionId.getInstance();
      const prefix2 = instance2.getPrefix();

      // Prefixes should be different (with extremely high probability)
      // since they're randomly generated
      expect(prefix1).not.toBe(prefix2);
    });
  });

  describe("getNext", () => {
    it("should generate sequential session IDs", () => {
      const instance = SessionId.getInstance();
      const prefix = instance.getPrefix();

      expect(instance.getNext()).toBe(`${prefix}/1`);
      expect(instance.getNext()).toBe(`${prefix}/2`);
      expect(instance.getNext()).toBe(`${prefix}/3`);
    });

    it("should maintain sequence across convenience function calls", () => {
      const id1 = getNextSessionId();
      const id2 = getNextSessionId();
      const id3 = getNextSessionId();

      // Extract sequence numbers
      const seq1 = parseInt(id1.split("/")[1]);
      const seq2 = parseInt(id2.split("/")[1]);
      const seq3 = parseInt(id3.split("/")[1]);

      expect(seq2).toBe(seq1 + 1);
      expect(seq3).toBe(seq2 + 1);
    });
  });

  describe("prefix format", () => {
    it("should generate a 5-character alphanumeric prefix", () => {
      const instance = SessionId.getInstance();
      const prefix = instance.getPrefix();

      // 5 random alphanumeric characters
      expect(prefix).toMatch(/^[A-Za-z0-9]{5}$/);
      expect(prefix.length).toBe(5);
    });
  });

  describe("formatWithSubSequence", () => {
    it("should format session ID with sub-sequence", () => {
      expect(SessionId.formatWithSubSequence("aB3xZ/3", 1)).toBe("aB3xZ/3.1");
      expect(SessionId.formatWithSubSequence("aB3xZ/3", 2)).toBe("aB3xZ/3.2");
      expect(SessionId.formatWithSubSequence("abcde/10", 5)).toBe("abcde/10.5");
    });

    it("should work with convenience function", () => {
      expect(formatSessionId("xyz12/42", 7)).toBe("xyz12/42.7");
    });
  });

  describe("getCurrentSequence", () => {
    it("should return current sequence without incrementing", () => {
      const instance = SessionId.getInstance();

      expect(instance.getCurrentSequence()).toBe(0);
      instance.getNext();
      expect(instance.getCurrentSequence()).toBe(1);
      expect(instance.getCurrentSequence()).toBe(1); // Should not increment
      instance.getNext();
      expect(instance.getCurrentSequence()).toBe(2);
    });
  });
});
