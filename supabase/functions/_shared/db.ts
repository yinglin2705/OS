import { createClient } from "@supabase/supabase-js";
export const db = () =>
  createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
export const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
export async function sendTelegram(chatId: string | number, text: string) {
  const response = await fetch(
    `https://api.telegram.org/bot${Deno.env.get("TELEGRAM_BOT_TOKEN")}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        link_preview_options: { is_disabled: true },
      }),
      signal: AbortSignal.timeout(15000),
    },
  );
  const body = await response.json();
  return {
    ok: body.ok === true,
    messageId: body.result?.message_id,
    status: response.status,
    retryAfter: body.parameters?.retry_after,
    error: body.description,
  };
}
