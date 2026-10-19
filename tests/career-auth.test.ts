import { beforeEach, it, expect, vi } from "vitest";
const m = vi.hoisted(() => ({
  origin: vi.fn(),
  user: vi.fn(),
  from: vi.fn(),
  rpc: vi.fn(),
}));
vi.mock("@/lib/server", () => ({
  sameOrigin: m.origin,
  serverDB: async () => ({
    auth: { getUser: m.user },
    from: m.from,
    rpc: m.rpc,
  }),
}));
import { POST } from "../app/api/career/route";
const req = (body: unknown) =>
  new Request("https://local.invalid/api/career", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
beforeEach(() => {
  vi.clearAllMocks();
  m.origin.mockReturnValue(true);
  m.user.mockResolvedValue({ data: { user: { id: "owner" } } });
});
it("blocks cross-origin actions before reading private data", async () => {
  m.origin.mockReturnValue(false);
  expect((await POST(req({ action: "analyse" }))).status).toBe(403);
  expect(m.user).not.toHaveBeenCalled();
});
it("requires a signed-in account", async () => {
  m.user.mockResolvedValue({ data: { user: null } });
  expect((await POST(req({ action: "analyse" }))).status).toBe(401);
  expect(m.from).not.toHaveBeenCalled();
});
it("requires explicit human draft approval and does not accept arbitrary draft bodies", async () => {
  const r = await POST(
    req({
      action: "draft",
      id: "60000000-0000-4000-8000-000000000001",
      kind: "cv",
      claim_ids: ["50000000-0000-4000-8000-000000000001"],
      body: "Invented experience",
    }),
  );
  expect(r.status).toBe(400);
  expect(m.rpc).not.toHaveBeenCalled();
});
it("does not expose database failure details or bypass the policy RPC", async () => {
  m.rpc.mockResolvedValue({
    data: null,
    error: { message: "private SQL body" },
  });
  const r = await POST(
    req({
      action: "draft",
      id: "60000000-0000-4000-8000-000000000001",
      kind: "cv",
      claim_ids: ["50000000-0000-4000-8000-000000000001"],
      approved: true,
    }),
  );
  expect(r.status).toBe(400);
  expect(m.rpc).toHaveBeenCalledWith(
    "career_create_draft",
    expect.objectContaining({ document_kind: "cv" }),
  );
  expect(await r.text()).not.toContain("private SQL body");
});
it("limits deletion to career-owned record types", async () => {
  expect(
    (
      await POST(
        req({
          action: "delete",
          id: "60000000-0000-4000-8000-000000000001",
          table: "events",
        }),
      )
    ).status,
  ).toBe(400);
  expect(m.from).not.toHaveBeenCalled();
});
it("rejects overlarge streaming payloads before querying career data", async () => {
  const r = await POST(req({ action: "job", raw_jd: "x".repeat(410000) }));
  expect(r.status).toBe(413);
  expect(m.from).not.toHaveBeenCalled();
});
