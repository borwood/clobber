import { describe, it, expect } from "bun:test";
import { resolvePort } from "../src/domain/port.ts";

describe("resolvePort", () => {
  it("returns default when env value is undefined", () => {
    expect(resolvePort(undefined, 3370)).toBe(3370);
  });

  it("returns default when env value is empty string", () => {
    expect(resolvePort("", 3370)).toBe(3370);
  });

  it("parses and returns a valid port number", () => {
    expect(resolvePort("3371", 3370)).toBe(3371);
  });

  it("accepts any default passed — not just 3370", () => {
    expect(resolvePort(undefined, 3470)).toBe(3470);
  });

  it("throws on non-numeric string", () => {
    expect(() => resolvePort("abc", 3370)).toThrow();
  });

  it("throws on partial parse (leading digits followed by non-digits)", () => {
    expect(() => resolvePort("3370abc", 3370)).toThrow();
  });

  it("throws on port 0 (reserved / out of range)", () => {
    expect(() => resolvePort("0", 3370)).toThrow();
  });

  it("throws on port above 65535", () => {
    expect(() => resolvePort("99999", 3370)).toThrow();
  });

  it("throws on negative port", () => {
    expect(() => resolvePort("-1", 3370)).toThrow();
  });

  it("accepts port 1 (lower bound)", () => {
    expect(resolvePort("1", 3370)).toBe(1);
  });

  it("accepts port 65535 (upper bound)", () => {
    expect(resolvePort("65535", 3370)).toBe(65535);
  });
});
