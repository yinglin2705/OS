import { db, json } from "../_shared/db.ts";
import { authorizedWebhook, parseLinkCode } from "../_shared/core.ts";
Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const expected = Deno.env.get("TELEGRAM_WEBHOOK_SECRET");
  if (
    !expected ||
    req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== expected
  )
    return json({ error: "Unauthorized" }, 401);
  let update;
  try {
    update = await req.json();
  } catch {
    return json({ error: "Bad JSON" }, 400);
  }
  const message = update.message;
  if (
    !message ||
    !authorizedWebhook(
      expected,
      req.headers.get("X-Telegram-Bot-Api-Secret-Token"),
      message.chat?.type,
    )
  )
    return json({ ok: true });
  const code = parseLinkCode(message.text);
  if (message.from?.id !== message.chat.id) return json({ ok: true });
  if (!code) {
    console.info(
      JSON.stringify({
        kind: "ying_telegram_link",
        outcome: "unsupported_code_format",
      }),
    );
    return json({ ok: true });
  }
  const { data, error } = await db().rpc("consume_link", {
    code,
    private_chat: message.chat.id,
  });
  if (error) {
    console.info(
      JSON.stringify({
        kind: "ying_telegram_link",
        outcome: "rpc_failed",
        error_code: String(error.code || "")
          .replace(/[^A-Z0-9]/g, "")
          .slice(0, 5),
      }),
    );
    return json({ error: "Link operation failed" }, 500);
  }
  console.info(
    JSON.stringify({
      kind: "ying_telegram_link",
      outcome: data ? "linked" : "expired_or_unknown_code",
    }),
  );
  // Test is durably queued; the next cron invocation sends it, even after this request exits.
  return json({ ok: true });
});
