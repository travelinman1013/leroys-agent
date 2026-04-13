import { describe, it, expect } from "vitest";
import { looksLikeSessionLog } from "../SessionLogViewer";

describe("looksLikeSessionLog", () => {
  it("detects session log with messages array", () => {
    const json = JSON.stringify({
      id: "abc123",
      model: "gemma-4-26b",
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi!" },
      ],
    });
    expect(looksLikeSessionLog(json)).toBe(true);
  });

  it("detects single message object", () => {
    const json = JSON.stringify({ role: "user", content: "Hello" });
    expect(looksLikeSessionLog(json)).toBe(true);
  });

  it("rejects non-session JSON", () => {
    const json = JSON.stringify({ repos: ["a", "b"], findings: [] });
    expect(looksLikeSessionLog(json)).toBe(false);
  });

  it("rejects empty object", () => {
    expect(looksLikeSessionLog("{}")).toBe(false);
  });

  it("rejects plain string", () => {
    expect(looksLikeSessionLog('"hello"')).toBe(false);
  });

  it("rejects array without role", () => {
    const json = JSON.stringify([{ name: "test", value: 42 }]);
    expect(looksLikeSessionLog(json)).toBe(false);
  });

  it("detects JSONL with role+content on first line", () => {
    const jsonl = `{"role":"user","content":"Hello"}
{"role":"assistant","content":"Hi"}`;
    expect(looksLikeSessionLog(jsonl)).toBe(true);
  });
});
