// Simulated CLI for subprocess tests only. Production never loads this fixture.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
const path = process.env.YING_TEST_DEPLOY_STATE;
const state = JSON.parse(readFileSync(path, "utf8"));
const argv = process.argv.slice(2);
const start = argv.indexOf("supabase");
const args = argv.slice(start + 1);
state.commands.push(args);
const emit = (value) => {
  writeFileSync(path, JSON.stringify(state));
  console.log(JSON.stringify(value));
};
if (args[0] === "functions" && args[1] === "list") emit(state.functions);
else if (args[0] === "secrets" && args[1] === "list")
  emit(
    Object.entries(state.secrets).map(([name, value]) => ({
      name,
      value: createHash("sha256").update(value).digest("hex"),
    })),
  );
else if (args[0] === "secrets" && args[1] === "set") {
  const content = readFileSync(args[args.indexOf("--env-file") + 1], "utf8");
  for (const line of content.trim().split("\n")) {
    const i = line.indexOf("=");
    state.secrets[line.slice(0, i)] = line.slice(i + 1);
  }
  emit({ ok: true });
} else if (args[0] === "functions" && args[1] === "deploy") {
  if (
    !args.includes("--use-api") ||
    !args.includes("--no-verify-jwt") ||
    !args.includes("--import-map")
  )
    throw new Error("Deploy flags missing");
  const name = args[2];
  state.functions = state.functions.filter((f) => f.slug !== name);
  state.functions.push({ slug: name, status: "ACTIVE", verify_jwt: false });
  emit({ ok: true });
} else if (args[0] === "db" && args[1] === "query") {
  const sql = readFileSync(args[args.indexOf("--file") + 1], "utf8");
  if (sql.includes("missing_tables"))
    emit([
      {
        cron_exists: state.cronExists,
        vault_exists: state.vaultExists,
        missing_tables: [],
        link_rpc: true,
        enqueue_rpc: true,
        claim_rpc: true,
      },
    ]);
  else if (sql.includes("create extension")) {
    state.cronExists = true;
    state.vaultExists = true;
    emit([{ prepared: true }]);
  } else if (
    sql
      .trim()
      .startsWith(
        "select id,name,decrypted_secret from vault.decrypted_secrets",
      )
  )
    emit(state.vault);
  else if (sql.includes("vault_synced")) {
    state.vault = [
      {
        id: "scheduler",
        name: "ying_scheduler_secret",
        decrypted_secret:
          sql.match(
            /vault.create_secret\('([^']+)','ying_scheduler_secret'/,
          )?.[1] || state.secrets.SCHEDULER_SECRET,
      },
      {
        id: "url",
        name: "ying_worker_url",
        decrypted_secret:
          "https://flhwcojxhsyjpzfqxttx.supabase.co/functions/v1/notification-worker",
      },
    ];
    emit([{ vault_synced: true }]);
  } else if (sql.includes("pg_advisory_xact_lock")) {
    state.jobs = [
      {
        jobid: 1,
        jobname: "existing-minute-job",
        schedule: "* * * * *",
        active: true,
      },
      {
        jobid: 2,
        jobname: "duplicate-minute-job",
        schedule: "* * * * *",
        active: false,
      },
    ];
    emit([{ cron_configured: true }]);
  } else if (sql.includes("from cron.job")) emit(state.jobs);
  else if (sql.includes("linked_accounts"))
    emit([
      {
        linked_accounts: 0,
        delivered_count: 0,
        pending_count: 0,
        failed_count: 0,
        uncertain_count: 0,
        latest_delivered_at: null,
      },
    ]);
  else throw new Error("Unrecognized fixture query");
} else throw new Error("Unexpected fixture CLI operation");
