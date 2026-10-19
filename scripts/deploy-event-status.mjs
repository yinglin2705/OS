import { readFile } from "node:fs/promises";
const ref = process.env.SUPABASE_PROJECT_REF || "flhwcojxhsyjpzfqxttx",
  token = process.env.SUPABASE_ACCESS_TOKEN;
if (!token || !/^[a-z]{20}$/.test(ref))
  throw Error("Missing protected Supabase access configuration.");
async function query(query) {
  const r = await fetch(
    `https://api.supabase.com/v1/projects/${ref}/database/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(60000),
    },
  );
  if (!r.ok)
    throw Error(
      `Status migration failed (HTTP ${r.status}); response not logged.`,
    );
  return r.json();
}
try {
  await query(
    await readFile(
      new URL("../supabase/migrations/008_event_status.sql", import.meta.url),
      "utf8",
    ),
  );
  const result = await query(
    "select has_function_privilege('authenticated','public.set_event_status(uuid,integer,text)','EXECUTE') as owner_gate,has_function_privilege('anon','public.set_event_status(uuid,integer,text)','EXECUTE') as anon_gate;",
  );
  if (!result[0]?.owner_gate || result[0]?.anon_gate)
    throw Error("Status RPC privacy verification failed.");
  console.log(
    "::notice title=Event status::Owner-only status RPC verified. No existing event data modified.",
  );
} catch (e) {
  console.error(e instanceof Error ? e.message : "Status deployment failed");
  process.exitCode = 1;
}
