import { db, json, sendTelegram } from "../_shared/db.ts";
import { briefing, quietUntil, splitMessage } from "../_shared/core.ts";
Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const secret = Deno.env.get("SCHEDULER_SECRET");
  if (!secret || req.headers.get("Authorization") !== `Bearer ${secret}`)
    return json({ error: "Unauthorized" }, 401);
  const client = db();
  const now = new Date().toISOString();
  const { error: enqueueError } = await client.rpc("enqueue_due");
  if (enqueueError) return json({ error: "Queue generation failed" }, 500);
  const { data: jobs, error } = await client.rpc("claim_deliveries");
  if (error) return json({ error: "Claim failed" }, 500);
  let sent = 0;
  for (const job of jobs || []) {
    const finish = async (values: Record<string, unknown>) => {
      const { error } = await client
        .from("notification_deliveries")
        .update({ ...values, lease_until: null })
        .eq("id", job.id)
        .eq("state", "sending");
      if (error) throw new Error("Delivery persistence failed");
    };
    try {
      if (Date.parse(now) - Date.parse(job.scheduled_at) > 86400000) {
        await finish({
          state: "failed",
          error: "Notification expired after 24 hours",
        });
        continue;
      }
      const [{ data: user }, { data: connection }] = await Promise.all([
        client.from("users").select("*").eq("id", job.user_id).single(),
        client
          .from("telegram_connections")
          .select("chat_id")
          .eq("user_id", job.user_id)
          .maybeSingle(),
      ]);
      if (!user || !connection) {
        await finish({
          state: "failed",
          error: "Telegram disconnected or account unavailable",
        });
        continue;
      }
      const resume = quietUntil(
        now,
        user.timezone,
        user.quiet_start,
        user.quiet_end,
      );
      if (resume) {
        await finish({
          state: "pending",
          next_attempt_at: resume,
          attempts: Math.max(0, job.attempts - 1),
          error: "Deferred by quiet hours",
        });
        continue;
      }
      let text =
        "YING OS · Telegram 连接测试成功。日历数据来自你的 Supabase 账户。";
      if (job.kind === "preparation") {
        const { data: r } = await client
          .from("reminder_jobs")
          .select("*,events(*),preparation_tasks(*)")
          .eq("id", job.reminder_id)
          .single();
        if (
          !r ||
          Date.parse(r.due_at) !== Date.parse(job.scheduled_at) ||
          r.state !== "approved" ||
          !["confirmed", "booked"].includes(r.events?.status) ||
          new Date(r.due_at) > new Date(now)
        ) {
          await finish({
            state: "failed",
            error: "Reminder disabled, changed or event no longer confirmed",
          });
          continue;
        }
        if (r.preparation_tasks?.completed) {
          await finish({
            state: "failed",
            error: "Preparation already completed",
          });
          continue;
        }
        if (user.reminder_intensity === "low" && r.priority === "low") {
          await finish({
            state: "failed",
            error: "Suppressed by low reminder intensity",
          });
          continue;
        }
        text = `${r.priority === "high" ? "⚠️ 重要准备" : "🎒 YING OS · 准备提醒"}\n${r.events.title}\n${r.preparation_tasks?.title || r.reason}\n原因：${r.reason}\n${r.events.preparation || ""}`;
        const { data: sources } = await client
          .from("event_sources")
          .select("url")
          .eq("event_id", r.event_id);
        text +=
          "\n" +
          (sources || [])
            .map((s) => s.url)
            .filter(Boolean)
            .join("\n");
      } else if (job.kind !== "test") {
        const { data: setting } = await client
          .from("scheduled_briefings")
          .select("enabled")
          .eq("user_id", job.user_id)
          .eq("kind", job.kind)
          .single();
        if (!setting?.enabled) {
          await finish({ state: "failed", error: "Briefing disabled" });
          continue;
        }
        const [
          { data: events, error: eventsError },
          { data: tasks, error: tasksError },
        ] = await Promise.all([
          client
            .from("events")
            .select("*,event_sources(url,notes)")
            .eq("user_id", job.user_id),
          client
            .from("preparation_tasks")
            .select("*")
            .eq("user_id", job.user_id)
            .eq("completed", false),
        ]);
        if (eventsError || tasksError)
          throw new Error("Briefing data unavailable");
        text = briefing(
          job.kind,
          job.scheduled_at,
          user.timezone,
          events || [],
          tasks || [],
        );
      }
      // One API call per delivery: prevents partially delivered multipart retries.
      const chunks = splitMessage(text, 3500);
      const message =
        chunks[0] + (chunks.length > 1 ? "\n…其余事项请在 YING OS 查看。" : "");
      const result = await sendTelegram(connection.chat_id, message);
      if (result.ok) {
        await finish({
          state: "sent",
          delivered_at: new Date().toISOString(),
          telegram_message_id: result.messageId,
          error: null,
        });
        if (job.reminder_id)
          await client
            .from("reminder_jobs")
            .update({ state: "sent" })
            .eq("id", job.reminder_id);
        sent++;
      } else if (result.status === 429 || result.status >= 500) {
        await finish({
          state: job.attempts >= 5 ? "failed" : "pending",
          next_attempt_at: new Date(
            Date.now() +
              Math.max(2 ** job.attempts * 30, result.retryAfter || 0) * 1000,
          ).toISOString(),
          error: String(result.error || "Telegram rejected request").slice(
            0,
            500,
          ),
        });
      } else
        await finish({
          state: "failed",
          error: String(result.error || "Telegram rejected request").slice(
            0,
            500,
          ),
        });
    } catch {
      // A transport timeout may follow a successful send. Do not resend automatically.
      await finish({
        state: "uncertain",
        error:
          "Transport or persistence failure; check Telegram before manually retrying",
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 1100)); // <1 per second, bounded batch < execution deadline.
  }
  return json({ claimed: jobs?.length || 0, sent });
});
