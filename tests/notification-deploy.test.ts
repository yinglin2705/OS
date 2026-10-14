import { describe, it, expect } from "vitest";
import {
  planSecrets,
  digest,
  assertFunctions,
  parseRows,
  sqlLiteral,
  redact,
} from "../scripts/lib/notification-deploy.mjs";
import { telegramAdmin } from "../supabase/functions/_shared/telegram-admin";
const candidate = "test-value-".repeat(8);
const bot = { name: "TELEGRAM_BOT_TOKEN", value: "digest-only" };
describe("deployment secret planning", () => {
  it("generates only missing secrets and reuses the bot binding", () => {
    let counter = 0;
    const plan = planSecrets(
      [bot],
      null,
      null,
      () => `generated-${++counter}-` + "x".repeat(64),
    );
    expect(Object.keys(plan.changes)).toEqual([
      "SCHEDULER_SECRET",
      "TELEGRAM_WEBHOOK_SECRET",
    ]);
    expect(plan.changes).not.toHaveProperty("TELEGRAM_BOT_TOKEN");
  });
  it("preserves a matching scheduler secret and existing webhook secret", () => {
    const plan = planSecrets(
      [
        bot,
        { name: "SCHEDULER_SECRET", value: digest(candidate) },
        { name: "TELEGRAM_WEBHOOK_SECRET", value: "digest" },
      ],
      candidate,
      null,
    );
    expect(plan.scheduler).toBe(candidate);
    expect(plan.changes).toEqual({});
  });
  it("refuses to rotate an existing unmatched scheduler secret", () =>
    expect(() =>
      planSecrets(
        [bot, { name: "SCHEDULER_SECRET", value: "unknown" }],
        null,
        null,
      ),
    ).toThrow("No existing secret was rotated"));
  it("refuses missing bot credentials instead of creating a placeholder", () =>
    expect(() => planSecrets([], null, null)).toThrow("TELEGRAM_BOT_TOKEN"));
  it("requires ACTIVE status and disabled JWT on both functions", () => {
    expect(() =>
      assertFunctions([
        { slug: "telegram-webhook", status: "ACTIVE", verify_jwt: false },
        { slug: "notification-worker", status: "ACTIVE", verify_jwt: false },
      ]),
    ).not.toThrow();
    expect(() =>
      assertFunctions([
        { slug: "telegram-webhook", status: "ACTIVE", verify_jwt: true },
      ]),
    ).toThrow();
  });
  it("parses CLI JSON rows and quotes SQL literals without logging response bodies", () => {
    expect(parseRows('[{"ready":true}]')).toEqual([{ ready: true }]);
    expect(sqlLiteral("don't")).toBe("'don''t'");
    expect(() => parseRows("{}")).toThrow("No response body was logged");
  });
  it("redacts generated and standard credentials from errors", () =>
    expect(
      redact(`scheduler=${candidate} sbp_supersecret`, [candidate]),
    ).not.toContain(candidate));
});
describe("Telegram administrative operations", () => {
  const env = (key: string) =>
    (
      ({
        TELEGRAM_BOT_TOKEN: "test-bot-token",
        TELEGRAM_WEBHOOK_SECRET: "test-webhook-secret",
        SUPABASE_URL: "https://example.supabase.co",
        SCHEDULER_SECRET: "test-scheduler-secret",
      }) as Record<string, string>
    )[key];
  it("keeps bot credentials in the Edge runtime and configures without dropping updates", async () => {
    const calls: { url: string; payload?: Record<string, unknown> }[] = [];
    const request = async (url: string | URL | Request, init?: RequestInit) => {
      const payload = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url: String(url), payload });
      const result = String(url).endsWith("getMe")
        ? { username: "ying_test_bot" }
        : String(url).endsWith("setWebhook")
          ? true
          : {
              url: "https://example.supabase.co/functions/v1/telegram-webhook",
              pending_update_count: 0,
            };
      return new Response(JSON.stringify({ ok: true, result }), {
        status: 200,
      });
    };
    const result = await telegramAdmin(
      "configure-webhook",
      env,
      request as typeof fetch,
    );
    expect(result.status).toBe(200);
    expect(result.body).toHaveProperty("url_matches", true);
    const set = calls.find((c) => c.url.endsWith("setWebhook"));
    expect(set?.payload).toMatchObject({
      secret_token: "test-webhook-secret",
      drop_pending_updates: false,
      allowed_updates: ["message"],
    });
    expect(JSON.stringify(result)).not.toContain("test-bot-token");
    expect(JSON.stringify(result)).not.toContain("test-webhook-secret");
  });
  it("does not overwrite a different existing webhook", async () => {
    let calls = 0;
    const request = async () => {
      calls++;
      return new Response(
        JSON.stringify({
          ok: true,
          result: { url: "https://another.example/webhook" },
        }),
      );
    };
    const result = await telegramAdmin(
      "configure-webhook",
      env,
      request as typeof fetch,
    );
    expect(result.status).toBe(409);
    expect(calls).toBe(1);
  });
  it("does not mutate webhook during read-only verification", async () => {
    const methods: string[] = [];
    const request = async (url: string | URL | Request) => {
      methods.push(String(url).split("/").at(-1)!);
      return new Response(
        JSON.stringify({
          ok: true,
          result: {
            url: "https://example.supabase.co/functions/v1/telegram-webhook",
            username: "bot",
          },
        }),
      );
    };
    await telegramAdmin("webhook-info", env, request as typeof fetch);
    expect(methods).toEqual(["getWebhookInfo", "getMe"]);
  });
  it("returns sanitized errors on Telegram failure", async () => {
    const result = await telegramAdmin("configure-webhook", env, (async () => {
      throw new Error("test-bot-token");
    }) as typeof fetch);
    expect(result.status).toBe(502);
    expect(JSON.stringify(result)).not.toContain("test-bot-token");
  });
});
