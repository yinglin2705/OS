const token = process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
const url = process.env.TELEGRAM_WEBHOOK_URL;
if (!token || !secret || !url || !url.startsWith("https://")) {
  console.error(
    "Set TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET and HTTPS TELEGRAM_WEBHOOK_URL securely.",
  );
  process.exit(1);
}
try {
  const response = await fetch(
    `https://api.telegram.org/bot${token}/setWebhook`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url,
        secret_token: secret,
        allowed_updates: ["message"],
        drop_pending_updates: false,
      }),
      signal: AbortSignal.timeout(15000),
    },
  );
  const result = await response.json();
  if (!result.ok) {
    console.error(
      `Webhook registration rejected (HTTP ${response.status}). Check bot credentials and HTTPS function URL.`,
    );
    process.exit(1);
  }
  console.log(
    "Telegram webhook registered successfully. Link an account and verify an actual test delivery.",
  );
} catch {
  console.error(
    "Webhook request failed. Check connectivity; no secret values were logged.",
  );
  process.exit(1);
}
