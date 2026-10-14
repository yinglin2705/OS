// Test-only network boundary; no external requests or real Telegram messages.
import { readFileSync } from "node:fs";
globalThis.fetch = async (url, options = {}) => {
  const state = JSON.parse(
    readFileSync(process.env.YING_TEST_DEPLOY_STATE, "utf8"),
  );
  if (
    !String(url).startsWith(
      "https://flhwcojxhsyjpzfqxttx.supabase.co/functions/v1/",
    )
  )
    throw new Error("Unexpected external request");
  if (!options.headers?.Authorization)
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
    });
  if (
    options.headers.Authorization !== `Bearer ${state.secrets.SCHEDULER_SECRET}`
  )
    return new Response("{}", { status: 401 });
  const action = JSON.parse(options.body).action;
  const body =
    action === "health"
      ? { ok: true, scheduler_configured: true }
      : action
        ? {
            ok: true,
            url_matches: true,
            pending_updates: 0,
            bot_username: "test_only_bot",
          }
        : { claimed: 0, sent: 0 };
  return new Response(JSON.stringify(body));
};
