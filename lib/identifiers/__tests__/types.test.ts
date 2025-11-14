import { describe, it, expect } from "@jest/globals";
import {
  SystemIdentifier,
  PointReference,
  PointPath,
  SeriesPath,
} from "../types";

describe("SystemIdentifier", () => {
  describe("parse()", () => {
    it("should parse numeric system IDs", () => {
      const result = SystemIdentifier.parse("123");
      expect(result).not.toBeNull();
      expect(result?.type).toBe("id");
      expect(result?.id).toBe(123);
    });

    it("should parse user.shortname format", () => {
      const result = SystemIdentifier.parse("simon.kinkora");
      expect(result).not.toBeNull();
      expect(result?.type).toBe("shortname");
      expect(result?.username).toBe("simon");
      expect(result?.shortname).toBe("kinkora");
    });

    it("should accept underscores and hyphens in usernames", () => {
      const result = SystemIdentifier.parse("john_doe-123.my-system_v2");
      expect(result).not.toBeNull();
      expect(result?.username).toBe("john_doe-123");
      expect(result?.shortname).toBe("my-system_v2");
    });

    it("should reject invalid formats", () => {
      expect(SystemIdentifier.parse("")).toBeNull();
      expect(SystemIdentifier.parse("invalid")).toBeNull();
      expect(SystemIdentifier.parse("0")).toBeNull(); // Zero is invalid
      expect(SystemIdentifier.parse("-5")).toBeNull(); // Negative is invalid
      expect(SystemIdentifier.parse("123.456.789")).toBeNull(); // Too many dots
      expect(SystemIdentifier.parse(".test")).toBeNull(); // Starts with dot
      expect(SystemIdentifier.parse("test.")).toBeNull(); // Ends with dot
      expect(SystemIdentifier.parse("user.name with spaces")).toBeNull();
      expect(SystemIdentifier.parse("user@domain.com")).toBeNull(); // Invalid chars
    });
  });

  describe("from()", () => {
    it("should create from valid string", () => {
      const result = SystemIdentifier.from("456");
      expect(result.type).toBe("id");
      expect(result.id).toBe(456);
    });

    it("should throw on invalid string", () => {
      expect(() => SystemIdentifier.from("invalid")).toThrow(
        "Invalid SystemIdentifier format: invalid",
      );
    });
  });

  describe("fromId()", () => {
    it("should create from positive integer", () => {
      const result = SystemIdentifier.fromId(789);
      expect(result.type).toBe("id");
      expect(result.id).toBe(789);
    });

    it("should reject zero and negative numbers", () => {
      expect(() => SystemIdentifier.fromId(0)).toThrow("Invalid system ID: 0");
      expect(() => SystemIdentifier.fromId(-5)).toThrow(
        "Invalid system ID: -5",
      );
    });

    it("should reject non-integers", () => {
      expect(() => SystemIdentifier.fromId(1.5)).toThrow(
        "Invalid system ID: 1.5",
      );
    });
  });

  describe("fromShortname()", () => {
    it("should create from username and shortname", () => {
      const result = SystemIdentifier.fromShortname("alice", "home");
      expect(result.type).toBe("shortname");
      expect(result.username).toBe("alice");
      expect(result.shortname).toBe("home");
    });

    it("should reject empty values", () => {
      expect(() => SystemIdentifier.fromShortname("", "test")).toThrow();
      expect(() => SystemIdentifier.fromShortname("test", "")).toThrow();
    });
  });

  describe("toString()", () => {
    it("should serialize numeric IDs", () => {
      const id = SystemIdentifier.fromId(999);
      expect(id.toString()).toBe("999");
    });

    it("should serialize user.shortname format", () => {
      const id = SystemIdentifier.fromShortname("bob", "office");
      expect(id.toString()).toBe("bob.office");
    });
  });

  describe("equals()", () => {
    it("should compare numeric IDs", () => {
      const id1 = SystemIdentifier.fromId(100);
      const id2 = SystemIdentifier.fromId(100);
      const id3 = SystemIdentifier.fromId(200);

      expect(id1.equals(id2)).toBe(true);
      expect(id1.equals(id3)).toBe(false);
    });

    it("should compare shortnames", () => {
      const id1 = SystemIdentifier.fromShortname("user", "sys1");
      const id2 = SystemIdentifier.fromShortname("user", "sys1");
      const id3 = SystemIdentifier.fromShortname("user", "sys2");

      expect(id1.equals(id2)).toBe(true);
      expect(id1.equals(id3)).toBe(false);
    });

    it("should return false for different types", () => {
      const id1 = SystemIdentifier.fromId(1);
      const id2 = SystemIdentifier.fromShortname("user", "sys");

      expect(id1.equals(id2)).toBe(false);
    });
  });
});

describe("PointReference", () => {
  describe("parse()", () => {
    it("should parse valid references", () => {
      const result = PointReference.parse("1.5");
      expect(result).not.toBeNull();
      expect(result?.systemId).toBe(1);
      expect(result?.pointId).toBe(5);
    });

    it("should reject invalid formats", () => {
      expect(PointReference.parse("")).toBeNull();
      expect(PointReference.parse("1")).toBeNull(); // Missing pointId
      expect(PointReference.parse("1.2.3")).toBeNull(); // Too many parts
      expect(PointReference.parse("0.5")).toBeNull(); // Zero systemId
      expect(PointReference.parse("1.0")).toBeNull(); // Zero pointId
      expect(PointReference.parse("-1.5")).toBeNull(); // Negative
      expect(PointReference.parse("1.5.0")).toBeNull(); // Extra parts
      expect(PointReference.parse("abc.def")).toBeNull(); // Non-numeric
    });
  });

  describe("fromIds()", () => {
    it("should create from valid IDs", () => {
      const result = PointReference.fromIds(10, 20);
      expect(result.systemId).toBe(10);
      expect(result.pointId).toBe(20);
    });

    it("should reject invalid IDs", () => {
      expect(() => PointReference.fromIds(0, 5)).toThrow();
      expect(() => PointReference.fromIds(5, 0)).toThrow();
      expect(() => PointReference.fromIds(-1, 5)).toThrow();
      expect(() => PointReference.fromIds(1.5, 5)).toThrow();
    });
  });

  describe("toString()", () => {
    it("should serialize to systemId.pointId format", () => {
      const ref = PointReference.fromIds(3, 7);
      expect(ref.toString()).toBe("3.7");
    });
  });

  describe("equals()", () => {
    it("should compare references correctly", () => {
      const ref1 = PointReference.fromIds(1, 5);
      const ref2 = PointReference.fromIds(1, 5);
      const ref3 = PointReference.fromIds(1, 6);
      const ref4 = PointReference.fromIds(2, 5);

      expect(ref1.equals(ref2)).toBe(true);
      expect(ref1.equals(ref3)).toBe(false);
      expect(ref1.equals(ref4)).toBe(false);
    });
  });
});

describe("PointPath", () => {
  describe("parse()", () => {
    it("should parse full type.subtype.extension/metric format", () => {
      const result = PointPath.parse("bidi.battery.charge/power");
      expect(result).not.toBeNull();
      expect(result?.type).toBe("bidi");
      expect(result?.subtype).toBe("battery");
      expect(result?.extension).toBe("charge");
      expect(result?.metricType).toBe("power");
      expect(result?.isFallback).toBe(false);
    });

    it("should parse type.subtype/metric format", () => {
      const result = PointPath.parse("load.hvac/power");
      expect(result).not.toBeNull();
      expect(result?.type).toBe("load");
      expect(result?.subtype).toBe("hvac");
      expect(result?.extension).toBeNull();
      expect(result?.metricType).toBe("power");
    });

    it("should parse type/metric format", () => {
      const result = PointPath.parse("load/power");
      expect(result).not.toBeNull();
      expect(result?.type).toBe("load");
      expect(result?.subtype).toBeNull();
      expect(result?.extension).toBeNull();
      expect(result?.metricType).toBe("power");
    });

    it("should parse fallback pointIndex/metric format", () => {
      const result = PointPath.parse("5/power");
      expect(result).not.toBeNull();
      expect(result?.type).toBe("5");
      expect(result?.metricType).toBe("power");
      expect(result?.isFallback).toBe(true);
      expect(result?.pointIndex).toBe(5);
    });

    it("should reject invalid formats", () => {
      expect(PointPath.parse("")).toBeNull();
      expect(PointPath.parse("no-slash")).toBeNull();
      expect(PointPath.parse("/power")).toBeNull(); // Empty type
      expect(PointPath.parse("load/")).toBeNull(); // Empty metric
      expect(PointPath.parse("a/b/c")).toBeNull(); // Too many slashes
      expect(PointPath.parse("0/power")).toBeNull(); // Zero pointIndex in fallback
      expect(PointPath.parse("load..sub/power")).toBeNull(); // Empty part
      expect(PointPath.parse("a.b.c.d/power")).toBeNull(); // Too many dots
    });
  });

  describe("fromComponents()", () => {
    it("should create from valid components", () => {
      const result = PointPath.fromComponents(
        "source",
        "solar",
        null,
        "energy",
      );
      expect(result.type).toBe("source");
      expect(result.subtype).toBe("solar");
      expect(result.extension).toBeNull();
      expect(result.metricType).toBe("energy");
      expect(result.isFallback).toBe(false);
    });

    it("should reject invalid components", () => {
      expect(() =>
        PointPath.fromComponents("", "sub", null, "power"),
      ).toThrow();
      expect(() => PointPath.fromComponents("type", "sub", null, "")).toThrow();
      expect(() =>
        PointPath.fromComponents("type", "", null, "power"),
      ).toThrow();
      expect(() =>
        PointPath.fromComponents("type", null, "", "power"),
      ).toThrow();
    });
  });

  describe("createFallback()", () => {
    it("should create fallback path", () => {
      const result = PointPath.createFallback(42, "voltage");
      expect(result.type).toBe("42");
      expect(result.metricType).toBe("voltage");
      expect(result.isFallback).toBe(true);
      expect(result.pointIndex).toBe(42);
    });

    it("should reject invalid parameters", () => {
      expect(() => PointPath.createFallback(0, "power")).toThrow();
      expect(() => PointPath.createFallback(-5, "power")).toThrow();
      expect(() => PointPath.createFallback(1.5, "power")).toThrow();
      expect(() => PointPath.createFallback(5, "")).toThrow();
    });
  });

  describe("toString()", () => {
    it("should serialize full path", () => {
      const path = PointPath.fromComponents(
        "bidi",
        "battery",
        "discharge",
        "power",
      );
      expect(path.toString()).toBe("bidi.battery.discharge/power");
    });

    it("should serialize partial path", () => {
      const path = PointPath.fromComponents("load", "hvac", null, "power");
      expect(path.toString()).toBe("load.hvac/power");
    });

    it("should serialize simple path", () => {
      const path = PointPath.fromComponents("grid", null, null, "frequency");
      expect(path.toString()).toBe("grid/frequency");
    });

    it("should serialize fallback path", () => {
      const path = PointPath.createFallback(8, "code");
      expect(path.toString()).toBe("8/code");
    });
  });

  describe("getPointIdentifier()", () => {
    it("should return identifier without metric type", () => {
      const path = PointPath.parse("load.hvac/power");
      expect(path?.getPointIdentifier()).toBe("load.hvac");
    });

    it("should handle fallback format", () => {
      const path = PointPath.parse("5/power");
      expect(path?.getPointIdentifier()).toBe("5");
    });
  });

  describe("pointIndex getter", () => {
    it("should return pointIndex for fallback paths", () => {
      const path = PointPath.createFallback(99, "power");
      expect(path.pointIndex).toBe(99);
    });

    it("should return null for non-fallback paths", () => {
      const path = PointPath.fromComponents("load", null, null, "power");
      expect(path.pointIndex).toBeNull();
    });
  });

  describe("equals()", () => {
    it("should compare paths correctly", () => {
      const path1 = PointPath.parse("load.hvac/power");
      const path2 = PointPath.parse("load.hvac/power");
      const path3 = PointPath.parse("load.pool/power");
      const path4 = PointPath.parse("load.hvac/energy");

      expect(path1?.equals(path2!)).toBe(true);
      expect(path1?.equals(path3!)).toBe(false);
      expect(path1?.equals(path4!)).toBe(false);
    });
  });
});

describe("SeriesPath", () => {
  describe("parse()", () => {
    it("should parse full series path with numeric system ID", () => {
      const result = SeriesPath.parse("1/load.hvac/power.avg");
      expect(result).not.toBeNull();
      expect(result?.systemIdentifier.type).toBe("id");
      expect(result?.systemIdentifier.id).toBe(1);
      expect(result?.pointPath.type).toBe("load");
      expect(result?.pointPath.subtype).toBe("hvac");
      expect(result?.pointPath.metricType).toBe("power");
      expect(result?.aggregationField).toBe("avg");
    });

    it("should parse series path with user.shortname", () => {
      const result = SeriesPath.parse("simon.kinkora/source.solar/power.avg");
      expect(result).not.toBeNull();
      expect(result?.systemIdentifier.type).toBe("shortname");
      expect(result?.systemIdentifier.username).toBe("simon");
      expect(result?.systemIdentifier.shortname).toBe("kinkora");
      expect(result?.pointPath.type).toBe("source");
      expect(result?.aggregationField).toBe("avg");
    });

    it("should parse series path with fallback point path", () => {
      const result = SeriesPath.parse("1/5/power.last");
      expect(result).not.toBeNull();
      expect(result?.systemIdentifier.id).toBe(1);
      expect(result?.pointPath.isFallback).toBe(true);
      expect(result?.pointPath.pointIndex).toBe(5);
      expect(result?.pointPath.metricType).toBe("power");
      expect(result?.aggregationField).toBe("last");
    });

    it("should reject invalid formats", () => {
      expect(SeriesPath.parse("")).toBeNull();
      expect(SeriesPath.parse("1")).toBeNull();
      expect(SeriesPath.parse("1/load")).toBeNull();
      expect(SeriesPath.parse("1/load/power")).toBeNull(); // Missing aggregation
      expect(SeriesPath.parse("invalid/load/power.avg")).toBeNull();
      expect(SeriesPath.parse("1/load/power.")).toBeNull(); // Empty aggregation
    });
  });

  describe("fromComponents()", () => {
    it("should create from components", () => {
      const sysId = SystemIdentifier.fromId(10);
      const pointPath = PointPath.fromComponents(
        "bidi",
        "battery",
        null,
        "soc",
      );
      const result = SeriesPath.fromComponents(sysId, pointPath, "last");

      expect(result.systemIdentifier.id).toBe(10);
      expect(result.pointPath.type).toBe("bidi");
      expect(result.aggregationField).toBe("last");
    });

    it("should reject empty aggregation field", () => {
      const sysId = SystemIdentifier.fromId(1);
      const pointPath = PointPath.fromComponents("load", null, null, "power");

      expect(() => SeriesPath.fromComponents(sysId, pointPath, "")).toThrow();
    });
  });

  describe("toString()", () => {
    it("should serialize with numeric system ID", () => {
      const sysId = SystemIdentifier.fromId(5);
      const pointPath = PointPath.fromComponents(
        "source",
        "solar",
        null,
        "energy",
      );
      const series = SeriesPath.fromComponents(sysId, pointPath, "delta");

      expect(series.toString()).toBe("5/source.solar/energy.delta");
    });

    it("should serialize with user.shortname", () => {
      const sysId = SystemIdentifier.fromShortname("alice", "home");
      const pointPath = PointPath.fromComponents("load", null, null, "power");
      const series = SeriesPath.fromComponents(sysId, pointPath, "avg");

      expect(series.toString()).toBe("alice.home/load/power.avg");
    });

    it("should serialize with fallback point path", () => {
      const sysId = SystemIdentifier.fromId(1);
      const pointPath = PointPath.createFallback(8, "code");
      const series = SeriesPath.fromComponents(sysId, pointPath, "last");

      expect(series.toString()).toBe("1/8/code.last");
    });
  });

  describe("equals()", () => {
    it("should compare series paths correctly", () => {
      const series1 = SeriesPath.parse("1/load/power.avg");
      const series2 = SeriesPath.parse("1/load/power.avg");
      const series3 = SeriesPath.parse("2/load/power.avg");
      const series4 = SeriesPath.parse("1/load/power.min");

      expect(series1?.equals(series2!)).toBe(true);
      expect(series1?.equals(series3!)).toBe(false);
      expect(series1?.equals(series4!)).toBe(false);
    });
  });

  describe("round-trip serialization", () => {
    const testCases = [
      "1/load.hvac/power.avg",
      "123/source.solar.local/energy.delta",
      "simon.kinkora/bidi.battery/soc.last",
      "1/5/power.avg", // Fallback format
    ];

    testCases.forEach((original) => {
      it(`should round-trip: ${original}`, () => {
        const parsed = SeriesPath.parse(original);
        expect(parsed).not.toBeNull();
        expect(parsed?.toString()).toBe(original);
      });
    });
  });
});
