export type AdminAction = "health" | "webhook-info" | "configure-webhook";
export async function telegramAdmin(
  action: AdminAction,
  env: (name: string) => string | undefined,
  request: typeof fetch = fetch,
) {
  const token = env("TELEGRAM_BOT_TOKEN");
  const secret = env("TELEGRAM_WEBHOOK_SECRET");
  const base = env("SUPABASE_URL");
  if (!token || !secret || !base)
    return {
      status: 503,
      body: { error: "Required Edge secrets are missing" },
    };
  if (action === "health")
    return {
      status: 200,
      body: {
        ok: true,
        bot_configured: true,
        webhook_secret_configured: true,
        scheduler_configured: !!env("SCHEDULER_SECRET"),
      },
    };
  const expected = new URL("/functions/v1/telegram-webhook", base).toString();
  const call = async (method: string, payload?: Record<string, unknown>) => {
    const response = await request(
      `https://api.telegram.org/bot${token}/${method}`,
      {
        method: payload ? "POST" : "GET",
        headers: payload ? { "Content-Type": "application/json" } : undefined,
        body: payload ? JSON.stringify(payload) : undefined,
        signal: AbortSignal.timeout(15000),
      },
    );
    const result = await response.json();
    if (!response.ok || result.ok !== true)
      throw new Error("Telegram API rejected the administrative operation");
    return result.result;
  };
  try {
    const info = await call("getWebhookInfo");
    if (action === "configure-webhook") {
      if (info.url && info.url !== expected)
        return {
          status: 409,
          body: {
            error:
              "This bot already targets another webhook. No changes made; review the existing integration first.",
          },
        };
      // Always set the secret, even for an already matching URL: Telegram does not reveal its value.
      await call("setWebhook", {
        url: expected,
        secret_token: secret,
        allowed_updates: ["message"],
        drop_pending_updates: false,
      });
    }
    const latest =
      action === "configure-webhook" ? await call("getWebhookInfo") : info;
    const bot = await call("getMe");
    return {
      status: 200,
      body: {
        ok: true,
        url_matches: latest.url === expected,
        pending_updates: latest.pending_update_count || 0,
        last_error_date: latest.last_error_date || null,
        last_error_http_status:
          String(latest.last_error_message || "").match(
            /webhook:\s*([45]\d{2})\b/i,
          )?.[1] || null,
        bot_username: bot.username || null,
      },
    };
  } catch {
    return {
      status: 502,
      body: {
        error:
          "Telegram administration failed. Check bot credentials or service connectivity; no secret values logged.",
      },
    };
  }
}
