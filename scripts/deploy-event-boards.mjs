import { readFile } from "node:fs/promises";
const ref = "flhwcojxhsyjpzfqxttx";
const token = process.env.SUPABASE_ACCESS_TOKEN;
if (!token) {
  console.error("Missing protected SUPABASE_ACCESS_TOKEN Actions secret.");
  process.exit(1);
}
async function query(sql) {
  const response = await fetch(
    `https://api.supabase.com/v1/projects/${ref}/database/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: sql }),
      signal: AbortSignal.timeout(90000),
    },
  );
  if (!response.ok)
    throw Error(
      `Database management request failed (HTTP ${response.status}); no response body logged.`,
    );
  return response.json();
}
try {
  const sql = await readFile(
    new URL("../supabase/migrations/002_event_boards.sql", import.meta.url),
    "utf8",
  );
  await query(sql);
  const rows = await query(
    "select (select count(*) from pg_tables where schemaname='public' and tablename in ('event_board_cards','event_board_edges') and rowsecurity) as private_tables,(select count(*) from pg_policies where schemaname='public' and tablename in ('event_board_cards','event_board_edges') and policyname='board_owner') as owner_policies,(select count(*) from storage.buckets where id='event-board' and public=false and file_size_limit=8388608 and allowed_mime_types=array['image/jpeg','image/png','image/webp','image/gif']) as private_bucket;",
  );
  if (
    !Array.isArray(rows) ||
    Number(rows[0]?.private_tables) !== 2 ||
    Number(rows[0]?.owner_policies) !== 2 ||
    Number(rows[0]?.private_bucket) !== 1
  )
    throw Error("Private board schema verification did not pass.");
  console.log(
    "::notice title=Private event board schema::Two RLS tables, owner policies and private image bucket verified; no event records changed.",
  );
} catch (e) {
  console.error(e instanceof Error ? e.message : "Schema deployment failed.");
  process.exitCode = 1;
}
