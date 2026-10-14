// Test-only network boundary; no external requests or real Telegram messages.
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
globalThis.fetch = async (url, options = {}) => {
  const state = JSON.parse(
    readFileSync(process.env.YING_TEST_DEPLOY_STATE, "utf8"),
  );
  if (String(url).includes("/analytics/endpoints/logs"))
    return new Response(
      JSON.stringify({ result: [{ http_status: "200", requests: 1 }] }),
    );
  if (
    String(url) ===
    "https://api.supabase.com/v1/projects/flhwcojxhsyjpzfqxttx/database/query"
  ) {
    if (options.headers.Authorization !== "Bearer fake-management-token")
      throw new Error("Management authorization missing");
    const path = join(
      dirname(process.env.YING_TEST_DEPLOY_STATE),
      "http-query.sql",
    );
    writeFileSync(path, JSON.parse(options.body).query, { mode: 0o600 });
    const body = execFileSync(
      process.execPath,
      [
        fileURLToPath(new URL("./notification-cli.mjs", import.meta.url)),
        "supabase",
        "db",
        "query",
        "--file",
        path,
      ],
      { encoding: "utf8" },
    );
    const after = JSON.parse(
      readFileSync(process.env.YING_TEST_DEPLOY_STATE, "utf8"),
    );
    after.commands[after.commands.length - 1] = ["management", "query"];
    writeFileSync(process.env.YING_TEST_DEPLOY_STATE, JSON.stringify(after));
    return new Response(body, { status: 201 });
  }
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
