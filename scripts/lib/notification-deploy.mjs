import { createHash, randomBytes } from "node:crypto";

export const CLI_VERSION = "2.121.0";
export const PROJECT_REF = "flhwcojxhsyjpzfqxttx";
export const FUNCTIONS = ["telegram-webhook", "notification-worker"];
export const sqlLiteral = (value) => `'${String(value).replaceAll("'", "''")}'`;
export const digest = (value) =>
  createHash("sha256").update(value).digest("hex");
export function parseRows(text) {
  const result = JSON.parse(text.trim());
  if (Array.isArray(result)) return result;
  if (Array.isArray(result.data)) return result.data;
  if (Array.isArray(result.rows)) return result.rows;
  throw new Error(
    "CLI returned an unexpected JSON format. No response body was logged.",
  );
}
export function planSecrets(
  records,
  vaultValue,
  suppliedValue,
  generate = () => randomBytes(32).toString("hex"),
) {
  const existing = new Map(records.map((s) => [s.name, s]));
  if (!existing.has("TELEGRAM_BOT_TOKEN"))
    throw new Error(
      "TELEGRAM_BOT_TOKEN is missing in Supabase Edge secrets. Add it securely there; do not send it in chat.",
    );
  const changes = {};
  const scheduler = existing.get("SCHEDULER_SECRET");
  let value;
  if (scheduler) {
    const expected = scheduler.digest || scheduler.value;
    value = [vaultValue, suppliedValue].find(
      (v) => typeof v === "string" && v.length >= 32 && digest(v) === expected,
    );
    if (!value)
      throw new Error(
        "An existing SCHEDULER_SECRET cannot be matched to Vault. Preserve it: supply it through a hidden local terminal prompt or a secure SCHEDULER_SECRET binding. No existing secret was rotated.",
      );
  } else {
    value =
      typeof vaultValue === "string" && vaultValue.length >= 32
        ? vaultValue
        : generate();
    changes.SCHEDULER_SECRET = value;
  }
  if (!existing.has("TELEGRAM_WEBHOOK_SECRET"))
    changes.TELEGRAM_WEBHOOK_SECRET = generate();
  return { scheduler: value, changes };
}
export function assertFunctions(records) {
  for (const name of FUNCTIONS) {
    const f = records.find((f) => f.slug === name || f.name === name);
    if (!f || f.verify_jwt !== false || f.status !== "ACTIVE")
      throw new Error(
        `${name} is not confirmed ACTIVE with verify_jwt=false. Stop before configuring Cron.`,
      );
  }
}
export function redact(text, known = []) {
  let out = String(text);
  for (const secret of known)
    if (secret) out = out.replaceAll(secret, "[REDACTED]");
  return out.replace(
    /sbp_[a-zA-Z0-9_-]+|sb_secret_[a-zA-Z0-9_-]+|\b\d{8,12}:[a-zA-Z0-9_-]{25,}|eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g,
    "[REDACTED]",
  );
}
