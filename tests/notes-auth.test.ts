import { beforeEach, afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  origin: vi.fn(),
  getUser: vi.fn(),
  admin: vi.fn(),
  from: vi.fn(),
}));
vi.mock("@/lib/server", () => ({
  sameOrigin: mocks.origin,
  serverDB: async () => ({
    auth: { getUser: mocks.getUser },
    from: mocks.from,
  }),
  adminDB: mocks.admin,
}));
import { GET, POST } from "../app/api/notes/ingest/route";
import { DELETE } from "../app/api/account/route";
beforeEach(() => {
  vi.clearAllMocks();
  mocks.origin.mockReturnValue(true);
  mocks.getUser.mockResolvedValue({ data: { user: { id: "owner-fixture" } } });
});
afterEach(() => vi.unstubAllEnvs());
it("rejects cross-origin writes before reading user data", async () => {
  mocks.origin.mockReturnValue(false);
  expect(
    (
      await POST(
        new Request("https://local.invalid/api/notes/ingest", {
          method: "POST",
        }),
      )
    ).status,
  ).toBe(403);
  expect(mocks.getUser).not.toHaveBeenCalled();
  expect(mocks.from).not.toHaveBeenCalled();
});
it("requires authentication for configuration and imports", async () => {
  mocks.getUser.mockResolvedValue({ data: { user: null } });
  expect((await GET()).status).toBe(401);
  expect(
    (await POST(new Request("https://local.invalid", { method: "POST" })))
      .status,
  ).toBe(401);
  expect(mocks.from).not.toHaveBeenCalled();
});
it("returns only readiness, never the model credential", async () => {
  vi.stubEnv("OPENAI_API_KEY", "fixture-private");
  const response = await GET();
  expect(await response.json()).toEqual({ aiConfigured: true });
});
it("blocks account deletion before touching files when server authorization is invalid", async () => {
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "fixture-only");
  const storage = vi.fn(),
    remove = vi.fn();
  mocks.admin.mockReturnValue({
    auth: {
      admin: {
        getUserById: async () => ({
          data: { user: null },
          error: { message: "invalid" },
        }),
        deleteUser: remove,
      },
    },
    storage: { from: storage },
  });
  const response = await DELETE(
    new Request("https://local.invalid/api/account", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmation: "永久删除我的账号" }),
    }),
  );
  expect(response.status).toBe(503);
  expect(storage).not.toHaveBeenCalled();
  expect(remove).not.toHaveBeenCalled();
  expect(await response.text()).not.toContain("fixture-only");
});
