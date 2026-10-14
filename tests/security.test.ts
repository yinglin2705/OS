import { describe, it, expect } from "vitest";
import { sameOrigin } from "../lib/security";
describe("request origin", () => {
  it("accepts a public host when Next binds internally to 0.0.0.0", () =>
    expect(
      sameOrigin(
        new Request("http://0.0.0.0:3000/api/ingest", {
          headers: { Host: "localhost:3000", Origin: "http://localhost:3000" },
        }),
      ),
    ).toBe(true));
  it("accepts HTTPS deployment through a trusted reverse proxy", () =>
    expect(
      sameOrigin(
        new Request("http://0.0.0.0:3000/api/ingest", {
          headers: {
            Host: "ying.example.com",
            Origin: "https://ying.example.com",
            "X-Forwarded-Proto": "https",
          },
        }),
      ),
    ).toBe(true));
  it("rejects foreign or missing origin", () => {
    expect(
      sameOrigin(
        new Request("http://localhost:3000", {
          headers: {
            Host: "localhost:3000",
            Origin: "https://attacker.example",
          },
        }),
      ),
    ).toBe(false);
    expect(sameOrigin(new Request("http://localhost:3000"))).toBe(false);
  });
  it("rejects malformed origins and cross-protocol requests", () => {
    expect(
      sameOrigin(
        new Request("https://ying.example.com", {
          headers: { Host: "ying.example.com", Origin: "not-a-url" },
        }),
      ),
    ).toBe(false);
    expect(
      sameOrigin(
        new Request("https://ying.example.com", {
          headers: {
            Host: "ying.example.com",
            Origin: "http://ying.example.com",
          },
        }),
      ),
    ).toBe(false);
  });
});
