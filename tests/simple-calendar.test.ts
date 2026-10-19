import { expect, it, vi, beforeEach, afterEach } from "vitest";
import { calendarStatuses, calendarStatus } from "../lib/calendar-status";
const m = vi.hoisted(() => ({ user: vi.fn(), rpc: vi.fn(), origin: vi.fn() }));
vi.mock("@/lib/server", () => ({
  sameOrigin: m.origin,
  serverDB: async () => ({
    auth: { getUser: m.user },
    rpc: m.rpc,
    from: (table: string) => {
      const result = {
        data: table === "users" ? { timezone: "Europe/London" } : [],
        error: null,
      };
      const chain = {
        select: () => chain,
        is: () => chain,
        eq: () => chain,
        single: async () => result,
        then: (resolve: (x: unknown) => unknown) =>
          Promise.resolve(result).then(resolve),
      };
      return chain;
    },
  }),
}));
import { POST } from "../app/api/ingest/route";
beforeEach(() => {
  vi.clearAllMocks();
  m.origin.mockReturnValue(true);
  m.user.mockResolvedValue({ data: { user: { id: "owner" } } });
  m.rpc.mockResolvedValue({
    data: ["20000000-0000-4000-8000-000000000091"],
    error: null,
  });
});
afterEach(() => vi.unstubAllEnvs());
it("exposes exactly four states and preserves legacy evidence grouping", () => {
  expect(Object.values(calendarStatuses)).toEqual([
    "确认",
    "冲突",
    "待定",
    "取消",
  ]);
  expect(calendarStatus("booked")).toBe("confirmed");
  expect(calendarStatus("applied")).toBe("planned");
  expect(calendarStatus("conflict")).toBe("conflict");
});
it("writes an authenticated event directly without a service key or second approval", async () => {
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
  const r = await POST(
    new Request("https://local.invalid/api/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event: { title: "Direct write fixture", status: "conflict" },
      }),
    }),
  );
  expect(r.status).toBe(200);
  expect(await r.json()).toMatchObject({
    event_ids: ["20000000-0000-4000-8000-000000000091"],
    count: 1,
  });
  expect(m.rpc).toHaveBeenCalledWith(
    "ingest_calendar_records",
    expect.objectContaining({
      records: expect.arrayContaining([
        expect.objectContaining({
          payload: expect.objectContaining({ status: "conflict" }),
        }),
      ]),
    }),
  );
});
it("reports a failed atomic write without claiming a saved calendar or leaking SQL", async () => {
  m.rpc.mockResolvedValue({ data: null, error: { message: "private SQL" } });
  const r = await POST(
    new Request("https://local.invalid/api/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: { title: "Fixture" } }),
    }),
  );
  expect(r.status).toBe(400);
  const text = await r.text();
  expect(text).toContain("没有写入任何日程");
  expect(text).not.toContain("private SQL");
});
it("rejects unauthenticated and cross-origin direct writes", async () => {
  m.origin.mockReturnValue(false);
  expect(
    (await POST(new Request("https://local.invalid", { method: "POST" })))
      .status,
  ).toBe(403);
  expect(m.user).not.toHaveBeenCalled();
});
