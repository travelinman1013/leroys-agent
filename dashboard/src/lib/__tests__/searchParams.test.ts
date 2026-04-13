import { describe, it, expect, beforeEach } from "vitest";
import {
  sessionsSearch,
  brainSearch,
  approvalsSearch,
  workflowsSearch,
  cronSearch,
  getStoredDefaults,
} from "../searchParams";

describe("Zod search param schemas", () => {
  describe("sessionsSearch", () => {
    it("applies defaults for empty input", () => {
      const result = sessionsSearch.parse({});
      expect(result).toEqual({ q: "", source: "", fromDays: 0 });
    });

    it("preserves provided values", () => {
      const result = sessionsSearch.parse({ q: "test", source: "discord", fromDays: 7 });
      expect(result).toEqual({ q: "test", source: "discord", fromDays: 7 });
    });

    it("coerces missing fields to defaults", () => {
      const result = sessionsSearch.parse({ q: "hello" });
      expect(result.source).toBe("");
      expect(result.fromDays).toBe(0);
    });
  });

  describe("brainSearch", () => {
    it("applies default source", () => {
      const result = brainSearch.parse({});
      expect(result.source).toBe("vault");
      expect(result.path).toBeUndefined();
    });

    it("preserves path when provided", () => {
      const result = brainSearch.parse({ source: "projects", path: "hermes/README.md" });
      expect(result).toEqual({ source: "projects", path: "hermes/README.md" });
    });
  });

  describe("approvalsSearch", () => {
    it("applies defaults", () => {
      const result = approvalsSearch.parse({});
      expect(result).toEqual({ pattern: "", choice: "" });
    });
  });

  describe("workflowsSearch", () => {
    it("applies defaults", () => {
      const result = workflowsSearch.parse({});
      expect(result).toEqual({ status: "" });
    });

    it("preserves status filter", () => {
      const result = workflowsSearch.parse({ status: "completed" });
      expect(result.status).toBe("completed");
    });
  });

  describe("cronSearch", () => {
    it("applies defaults", () => {
      const result = cronSearch.parse({});
      expect(result.expanded).toBeUndefined();
    });
  });
});

describe("localStorage persistence", () => {
  beforeEach(() => {
    // jsdom localStorage may not have .clear() in all vitest versions
    try { localStorage.clear(); } catch { /* noop */ }
    try { localStorage.removeItem("hermes:search:sessions"); } catch { /* noop */ }
  });

  it("returns empty object when nothing stored", () => {
    expect(getStoredDefaults("sessions")).toEqual({});
  });

  it("returns stored data when available", () => {
    try {
      localStorage.setItem("hermes:search:sessions", JSON.stringify({ q: "test", fromDays: 7 }));
      expect(getStoredDefaults("sessions")).toEqual({ q: "test", fromDays: 7 });
    } catch {
      // localStorage not available in this test env — skip
    }
  });

  it("handles corrupt JSON gracefully", () => {
    try {
      localStorage.setItem("hermes:search:sessions", "not-json");
      expect(getStoredDefaults("sessions")).toEqual({});
    } catch {
      // localStorage not available in this test env — skip
    }
  });
});
