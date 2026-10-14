import { spawn } from "node:child_process";
import {
  mkdtemp,
  writeFile,
  readFile,
  rm,
  chmod,
  appendFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLI_VERSION,
  PROJECT_REF,
  FUNCTIONS,
  parseRows,
  planSecrets,
  assertFunctions,
  sqlLiteral,
  redact,
} from "./lib/notification-deploy.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const refIndex = args.indexOf("--project-ref");
const ref = refIndex < 0 ? PROJECT_REF : args[refIndex + 1];
if (!/^[a-z]{20}$/.test(ref || "")) throw new Error("Invalid project ref.");
const inspect = flag("--inspect"),
  verify = flag("--verify");
const known = [
  process.env.SUPABASE_ACCESS_TOKEN,
  process.env.SCHEDULER_SECRET,
].filter(Boolean);
const base = `https://${ref}.supabase.co`;
const worker = `${base}/functions/v1/notification-worker`;
const folder = await mkdtemp(join(tmpdir(), "ying-deploy-"));
await chmod(folder, 0o700);
let fileCounter = 0;
const report = {
  status: "running",
  project_ref: ref,
  mode: inspect ? "inspect" : verify ? "verify" : "deploy",
};
const say = (message) => console.log(redact(message, known));

async function cli(params, interactive = false) {
  if (!process.env.npm_execpath)
    throw new Error("Run this script through npm run deploy:notifications.");
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        process.env.npm_execpath,
        "exec",
        "--cache",
        process.env.YING_DEPLOY_NPM_CACHE || join(tmpdir(), "ying-npm-cache"),
        "--yes",
        `--package=supabase@${CLI_VERSION}`,
        "--",
        "supabase",
        ...params,
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          SUPABASE_HOME:
            process.env.SUPABASE_HOME || join(tmpdir(), "ying-supabase-auth"),
          npm_config_cache:
            process.env.npm_config_cache || join(tmpdir(), "ying-npm-cache"),
          DO_NOT_TRACK: "1",
        },
        stdio: interactive ? "inherit" : ["ignore", "pipe", "pipe"],
      },
    );
    let output = "",
      error = "";
    if (!interactive) {
      child.stdout.on("data", (x) => (output += x));
      child.stderr.on("data", (x) => (error += x));
    }
    child.on("error", () =>
      reject(
        new Error(
          "Could not start the Supabase CLI. Check Node/npm installation.",
        ),
      ),
    );
    child.on("close", (code) =>
      code === 0
        ? resolve(output)
        : reject(
            new Error(
              redact(
                `Supabase CLI ${params.slice(0, 2).join(" ")} failed: ${error.slice(-1500) || "nonzero exit status"}`,
                known,
              ),
            ),
          ),
    );
  });
}
async function rows(params) {
  return parseRows(await cli([...params, "--agent", "no", "-o", "json"]));
}
async function query(sql) {
  const path = join(folder, `query-${++fileCounter}.sql`);
  await writeFile(path, sql, { mode: 0o600 });
  try {
    return await rows([
      "db",
      "query",
      "--linked",
      "--project-ref",
      ref,
      "--file",
      path,
    ]);
  } finally {
    await rm(path, { force: true });
  }
}
async function edge(action) {
  const response = await fetch(worker, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${scheduler}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(action ? { action } : {}),
    signal: AbortSignal.timeout(100000),
  });
  const body = await response.json();
  if (!response.ok)
    throw new Error(
      `Worker ${action || "process"} returned ${response.status}: ${body.error || "request failed"}`,
    );
  return body;
}
async function jwtProbe() {
  for (const name of FUNCTIONS) {
    const response = await fetch(`${base}/functions/v1/${name}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(20000),
    });
    const body = await response.json();
    if (response.status !== 401 || body.error !== "Unauthorized")
      throw new Error(
        `${name}: application authorization could not be verified. Gateway JWT may still be enabled or deployed code differs.`,
      );
  }
}
async function secretRows() {
  return rows(["secrets", "list", "--project-ref", ref]);
}
let scheduler;
try {
  say(
    `Inspecting Supabase project ${ref}. No migration replay, secret values or bot tokens are logged.`,
  );
  let functions;
  try {
    functions = await rows(["functions", "list", "--project-ref", ref]);
  } catch (error) {
    if (
      !inspect &&
      !verify &&
      process.stdin.isTTY &&
      !process.env.CI &&
      /Access token not provided/i.test(error.message)
    ) {
      say(
        "Authorize in the browser; type the verification code only in this local terminal. Do not send it in chat.",
      );
      await cli(["login", "--name", "YING-OS-notifications"], true);
      functions = await rows(["functions", "list", "--project-ref", ref]);
    } else throw error;
  }
  const secrets = await secretRows();
  say(
    `Existing functions: ${functions.map((f) => `${f.slug || f.name} (JWT ${String(f.verify_jwt)})`).join(", ") || "none"}`,
  );
  say(`Edge secret names: ${secrets.map((s) => s.name).join(", ")}`);
  const [schema] = await query(
    "select to_regclass('cron.job') is not null as cron_exists,to_regclass('vault.decrypted_secrets') is not null as vault_exists,array(select name from (values('users'),('events'),('telegram_connections'),('notification_deliveries'),('reminder_jobs'),('telegram_link_codes')) names(name) where to_regclass('public.'||name) is null) as missing_tables,to_regprocedure('public.consume_link(text,bigint)') is not null as link_rpc,to_regprocedure('public.enqueue_due()') is not null as enqueue_rpc,to_regprocedure('public.claim_deliveries()') is not null as claim_rpc;",
  );
  if (
    schema.missing_tables.length ||
    !schema.link_rpc ||
    !schema.enqueue_rpc ||
    !schema.claim_rpc
  )
    throw new Error(
      "Notification database prerequisites are missing. Initial migration was not replayed; inspect the existing schema before changing it.",
    );
  const cronState = async () =>
    query(
      `select jobid,jobname,schedule,active from cron.job where jobname='ying-os-every-minute' or position(${sqlLiteral(worker)} in command)>0 or position('ying_worker_url' in command)>0 order by jobid;`,
    );
  if (schema.cron_exists)
    say(`Existing YING OS Cron jobs: ${JSON.stringify(await cronState())}`);
  else say("No pg_cron installation found.");
  const deliveryState = async () =>
    query(
      "select (select count(*) from public.telegram_connections) as linked_accounts,(select count(*) from public.notification_deliveries where state='sent') as delivered_count,(select count(*) from public.notification_deliveries where state='pending') as pending_count,(select count(*) from public.notification_deliveries where state='failed') as failed_count,(select count(*) from public.notification_deliveries where state='uncertain') as uncertain_count,(select max(delivered_at) from public.notification_deliveries where state='sent') as latest_delivered_at;",
    );
  report.delivery_before = await deliveryState();
  say(`Current delivery state: ${JSON.stringify(report.delivery_before)}`);
  if (inspect) {
    say(
      "Read-only inspection complete. No functions, secrets, webhook or Cron jobs changed.",
    );
  } else {
    if (!verify) {
      await query(
        "create schema if not exists extensions;create schema if not exists vault;create extension if not exists pg_cron;create extension if not exists pg_net with schema extensions;create extension if not exists supabase_vault with schema vault;select true as prepared;",
      );
    } else if (!schema.vault_exists || !schema.cron_exists)
      throw new Error(
        "Cron/Vault are not yet configured; verification stopped without making changes.",
      );
    const vault = await query(
      "select id,name,decrypted_secret from vault.decrypted_secrets where name in ('ying_scheduler_secret','ying_worker_url');",
    );
    if (
      vault.filter((v) => v.name === "ying_scheduler_secret").length > 1 ||
      vault.filter((v) => v.name === "ying_worker_url").length > 1
    )
      throw new Error(
        "Duplicate YING OS Vault entries found. No secrets or Cron jobs were changed.",
      );
    const vaultValue = vault.find(
      (v) => v.name === "ying_scheduler_secret",
    )?.decrypted_secret;
    if (vaultValue) known.push(vaultValue);
    const plan = planSecrets(secrets, vaultValue, process.env.SCHEDULER_SECRET);
    scheduler = plan.scheduler;
    known.push(scheduler, ...Object.values(plan.changes));
    if (verify && Object.keys(plan.changes).length)
      throw new Error(
        "Some Edge secrets are missing; verification does not create them.",
      );
    if (!verify) {
      // Persist the scheduler in Vault first so an interrupted Edge-secret write is recoverable.
      await query(`do $$ declare existing_id uuid; begin
    select id into existing_id from vault.secrets where name='ying_scheduler_secret';
    if existing_id is null then perform vault.create_secret(${sqlLiteral(scheduler)},'ying_scheduler_secret','YING OS worker authentication');else perform vault.update_secret(existing_id,${sqlLiteral(scheduler)},'ying_scheduler_secret');end if;
    select id into existing_id from vault.secrets where name='ying_worker_url';
    if existing_id is null then perform vault.create_secret(${sqlLiteral(worker)},'ying_worker_url','YING OS notification endpoint');else perform vault.update_secret(existing_id,${sqlLiteral(worker)},'ying_worker_url');end if;
    end $$;select true as vault_synced;`);
      if (Object.keys(plan.changes).length) {
        const path = join(folder, "secrets.env");
        await writeFile(
          path,
          Object.entries(plan.changes)
            .map(([name, value]) => `${name}=${value}`)
            .join("\n") + "\n",
          { mode: 0o600 },
        );
        try {
          await cli([
            "secrets",
            "set",
            "--project-ref",
            ref,
            "--env-file",
            path,
          ]);
        } finally {
          await rm(path, { force: true });
        }
        say(
          `Created missing Edge secret names: ${Object.keys(plan.changes).join(", ")}`,
        );
      } else say("Existing Edge secrets preserved.");
      const finalSecrets = await secretRows();
      for (const name of [
        "SCHEDULER_SECRET",
        "TELEGRAM_WEBHOOK_SECRET",
        "TELEGRAM_BOT_TOKEN",
      ])
        if (!finalSecrets.some((s) => s.name === name))
          throw new Error(`Secret requirement ${name} remains unresolved.`);
      for (const name of FUNCTIONS) {
        say(
          `Deploying ${name} from repository sources and shared dependencies.`,
        );
        await cli([
          "functions",
          "deploy",
          name,
          "--project-ref",
          ref,
          "--no-verify-jwt",
          "--use-api",
          "--import-map",
          "supabase/functions/deno.json",
        ]);
      }
    }
    functions = await rows(["functions", "list", "--project-ref", ref]);
    assertFunctions(functions);
    report.functions = functions
      .filter((f) => FUNCTIONS.includes(f.slug || f.name))
      .map((f) => ({
        name: f.slug || f.name,
        status: f.status,
        verify_jwt: f.verify_jwt,
      }));
    await jwtProbe();
    say(
      "Both functions are ACTIVE, JWT gateway verification disabled, and application-level authorization verified.",
    );
    const health = await edge("health");
    if (!health.ok || !health.scheduler_configured)
      throw new Error("Worker secret readiness check failed.");
    const webhook = await edge(verify ? "webhook-info" : "configure-webhook");
    if (!webhook.url_matches)
      throw new Error(
        "Telegram webhook is not targeting the expected function.",
      );
    report.webhook = {
      verified: webhook.url_matches,
      bot_username: webhook.bot_username,
      pending_updates: webhook.pending_updates,
    };
    say(
      `Webhook verified; bot @${webhook.bot_username || "unknown"}, queued Telegram updates ${webhook.pending_updates}.`,
    );
    if (!verify) {
      await query(
        (await readFile(join(root, "supabase/cron.sql"), "utf8")) +
          "\nselect true as cron_configured;",
      );
    }
    const jobs = await cronState();
    if (
      jobs.filter((j) => j.active).length !== 1 ||
      jobs.find((j) => j.active)?.schedule !== "* * * * *"
    )
      throw new Error("Exactly one active minute Cron job was not confirmed.");
    report.cron = jobs;
    say(`Cron verified: ${JSON.stringify(jobs)}`);
    if (!verify) {
      report.worker = await edge();
      say(`Initial worker run: ${JSON.stringify(report.worker)}`);
    }
    report.delivery_after = await deliveryState();
    say(`Delivery state: ${JSON.stringify(report.delivery_after)}`);
    say(
      "Deployment/verification checks passed. This does not prove a real message was received.",
    );
    say(
      `Open YING OS → 设置与通知 → 连接 Telegram, send the one-time code privately to @${webhook.bot_username || "your bot"}, then check the actual received message and sent delivery history. Quiet hours still apply.`,
    );
  }
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  console.error(redact(error.message, known));
  console.error(
    "No credentials should be pasted into chat. Local authorization: npm exec --yes --package=supabase@2.121.0 -- supabase login. For CI use the protected GitHub Actions secret SUPABASE_ACCESS_TOKEN.",
  );
  process.exitCode = 1;
} finally {
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `## YING OS notification deployment\n\nVerified infrastructure results; no credential values or chat IDs. A successful deployment does not prove actual message receipt.\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n`,
    );
  }
  await rm(folder, { recursive: true, force: true });
}
