import { db, json } from "../_shared/db.ts";
import { authorizedWebhook } from "../_shared/core.ts";
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
  const match = String(message.text || "").match(
    /^(?:\/start\s+)?(YING-[A-F0-9]{24})$/,
  );
  if (!match || message.from?.id !== message.chat.id) return json({ ok: true }); // Silent to unsolicited, unlinked chats.
  const { error } = await db().rpc("consume_link", {
    code: match[1],
    private_chat: message.chat.id,
  });
  if (error) return json({ error: "Link operation failed" }, 500);
  // Test is durably queued; the next cron invocation sends it, even after this request exits.
  return json({ ok: true });
});
