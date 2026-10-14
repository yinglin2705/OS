"use client";
import { useEffect, useState } from "react";
import { DateTime } from "luxon";
import { browserDB } from "@/lib/supabase";
type Profile = {
  timezone: string;
  quiet_start: string | null;
  quiet_end: string | null;
  reminder_intensity: string;
};
type Schedule = {
  id: string;
  kind: string;
  local_time: string;
  enabled: boolean;
};
type Reminder = {
  id: string;
  due_at: string;
  state: string;
  reason: string;
  priority: string;
  events: { title: string } | null;
};
type Delivery = {
  id: string;
  kind: string;
  state: string;
  scheduled_at: string;
  delivered_at: string | null;
  attempts: number;
  error: string | null;
};
const names: Record<string, string> = {
  morning: "早安简报",
  tomorrow: "明日简报",
  weekly: "下周简报（周日）",
  test: "测试通知",
  preparation: "准备提醒",
};
export default function Settings({
  userId,
  onMessage,
  onRefresh,
}: {
  userId: string;
  onMessage: (s: string) => void;
  onRefresh: () => Promise<void>;
}) {
  const [profile, setProfile] = useState<Profile | null>(null),
    [schedules, setSchedules] = useState<Schedule[]>([]),
    [reminders, setReminders] = useState<Reminder[]>([]),
    [deliveries, setDeliveries] = useState<Delivery[]>([]),
    [connected, setConnected] = useState(false),
    [code, setCode] = useState(""),
    [busy, setBusy] = useState(false);
  async function load() {
    const db = browserDB();
    const results = await Promise.all([
      db.from("users").select("*").eq("id", userId).single(),
      db.from("scheduled_briefings").select("*").order("local_time"),
      db.from("telegram_connections").select("connected_at").maybeSingle(),
      db
        .from("reminder_jobs")
        .select("*,events(title)")
        .order("due_at")
        .limit(100),
      db
        .from("notification_deliveries")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(50),
    ]);
    const error = results.find((r) => r.error)?.error;
    if (error) {
      onMessage(error.message);
      return;
    }
    setProfile(results[0].data);
    setSchedules(results[1].data || []);
    setConnected(!!results[2].data);
    setReminders(results[3].data || []);
    setDeliveries(results[4].data || []);
  }
  useEffect(() => {
    void load();
  }, [userId]);
  async function telegram(action: string) {
    setBusy(true);
    try {
      const res = await fetch("/api/telegram", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const body = await res.json();
      onMessage(body.error || body.message);
      if (body.code) setCode(body.code);
      if (action === "disconnect") setCode("");
      await load();
    } catch {
      onMessage("请求失败，请重试");
    } finally {
      setBusy(false);
    }
  }
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!profile) return;
    if (!DateTime.now().setZone(profile.timezone).isValid) {
      onMessage("请输入有效的 IANA 时区，如 Europe/London");
      return;
    }
    setBusy(true);
    const db = browserDB();
    const { error } = await db.from("users").update(profile).eq("id", userId);
    if (error) {
      onMessage(error.message);
      setBusy(false);
      return;
    }
    for (const s of schedules) {
      const { error } = await db
        .from("scheduled_briefings")
        .update({ enabled: s.enabled, local_time: s.local_time })
        .eq("id", s.id);
      if (error) {
        onMessage(error.message);
        setBusy(false);
        return;
      }
    }
    onMessage(
      "通知设置已保存；后台发送仍需配置 Cron、Edge Functions 和 Telegram webhook。",
    );
    setBusy(false);
    await onRefresh();
  }
  async function reminder(r: Reminder, values: Record<string, unknown>) {
    const { error } = await browserDB()
      .from("reminder_jobs")
      .update(values)
      .eq("id", r.id);
    onMessage(error ? error.message : "提醒已更新");
    await load();
  }
  if (!profile) return <p>正在读取通知设置…</p>;
  return (
    <div className="settings-grid">
      <section className="panel">
        <p className="eyebrow">PRIVATE DELIVERY</p>
        <h2>连接 Telegram</h2>
        <p>{connected ? "● 已绑定私聊" : "○ 尚未绑定"}</p>
        <p className="muted">
          绑定成功不代表通知已启用。请先配置 webhook 与每分钟
          Cron，再检查测试通知是否真实送达。
        </p>
        <div className="actions">
          <button
            className="primary"
            disabled={busy}
            onClick={() => telegram("link")}
          >
            {connected ? "重新连接" : "连接 Telegram"}
          </button>
          <button
            disabled={busy || !connected}
            onClick={() => telegram("test")}
          >
            发送测试
          </button>
          {connected && (
            <button disabled={busy} onClick={() => telegram("disconnect")}>
              断开连接
            </button>
          )}
          <button onClick={load}>刷新状态</button>
        </div>
        {code && (
          <div className="link-code">
            <p>在你的机器人私聊中发送：</p>
            <code>{code}</code>
            <p className="muted">
              十分钟有效、只能使用一次。请勿分享此代码。发送后点击“刷新状态”。
            </p>
          </div>
        )}
      </section>
      <section className="panel">
        <h2>发送偏好</h2>
        <form onSubmit={save}>
          <label>
            时区
            <input
              value={profile.timezone}
              onChange={(e) =>
                setProfile({ ...profile, timezone: e.target.value })
              }
              placeholder="Europe/London"
              required
            />
          </label>
          {schedules.map((s) => (
            <div className="schedule" key={s.id}>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={s.enabled}
                  onChange={(e) =>
                    setSchedules(
                      schedules.map((x) =>
                        x.id === s.id ? { ...x, enabled: e.target.checked } : x,
                      ),
                    )
                  }
                />
                {names[s.kind]}
              </label>
              <input
                aria-label={names[s.kind] + "时间"}
                type="time"
                step="60"
                value={s.local_time.slice(0, 5)}
                onChange={(e) =>
                  setSchedules(
                    schedules.map((x) =>
                      x.id === s.id ? { ...x, local_time: e.target.value } : x,
                    ),
                  )
                }
                required
              />
            </div>
          ))}
          <div className="form-grid">
            <label>
              静音开始
              <input
                type="time"
                value={profile.quiet_start?.slice(0, 5) || ""}
                onChange={(e) =>
                  setProfile({
                    ...profile,
                    quiet_start: e.target.value || null,
                  })
                }
              />
            </label>
            <label>
              静音结束
              <input
                type="time"
                value={profile.quiet_end?.slice(0, 5) || ""}
                onChange={(e) =>
                  setProfile({ ...profile, quiet_end: e.target.value || null })
                }
              />
            </label>
          </div>
          <p className="muted">
            所有通知均遵守静音时段，包括重要提醒。两个时间留空可关闭静音。
          </p>
          <label>
            提醒强度
            <select
              value={profile.reminder_intensity}
              onChange={(e) =>
                setProfile({ ...profile, reminder_intensity: e.target.value })
              }
            >
              <option value="low">少量：过滤低优先级提醒</option>
              <option value="normal">正常：发送已批准提醒</option>
              <option value="high">完整：发送已批准提醒</option>
            </select>
          </label>
          <p className="muted">
            正常与完整当前均不会额外生成通知，避免重复打扰。
          </p>
          <button className="primary" disabled={busy}>
            保存设置
          </button>
        </form>
      </section>
      <section className="panel wide">
        <h2>准备提醒 · 最近 100 项</h2>
        <p className="muted">
          系统自动生成建议，逐条批准后才会发送。可编辑时间、延后或停用。
        </p>
        {reminders.map((r) => (
          <div className="reminder-row" key={r.id}>
            <div>
              <strong>{r.events?.title || "活动"}</strong>
              <p>{r.reason}</p>
              <small>
                {
                  (
                    {
                      proposed: "待批准",
                      approved: "已批准",
                      disabled: "已停用",
                      sent: "已发送",
                    } as Record<string, string>
                  )[r.state]
                }{" "}
                · {r.priority}
              </small>
            </div>
            <input
              type="datetime-local"
              aria-label="提醒时间"
              defaultValue={DateTime.fromISO(r.due_at)
                .setZone(profile.timezone)
                .toFormat("yyyy-MM-dd'T'HH:mm")}
              onBlur={(e) => {
                if (!e.target.value) return;
                const d = DateTime.fromISO(e.target.value, {
                  zone: profile.timezone,
                });
                if (
                  !d.isValid ||
                  d.getPossibleOffsets().length > 1 ||
                  d.toFormat("yyyy-MM-dd'T'HH:mm") !== e.target.value
                ) {
                  onMessage("时间不存在或存在夏令时歧义");
                  return;
                }
                if (d.toUTC().toISO() !== r.due_at)
                  void reminder(r, {
                    due_at: d.toUTC().toISO(),
                    state: "proposed",
                  });
              }}
            />
            <div className="actions">
              {r.state !== "sent" && (
                <>
                  <button onClick={() => reminder(r, { state: "approved" })}>
                    批准
                  </button>
                  <button
                    onClick={() =>
                      reminder(r, {
                        due_at: DateTime.now()
                          .plus({ hours: 1 })
                          .toUTC()
                          .toISO(),
                        state: "approved",
                      })
                    }
                  >
                    延后一小时
                  </button>
                  <button onClick={() => reminder(r, { state: "disabled" })}>
                    停用
                  </button>
                </>
              )}
            </div>
          </div>
        ))}
        {!reminders.length && <p className="empty">确认活动后生成建议。</p>}
      </section>
      <section className="panel wide">
        <div className="toolbar">
          <h2>通知历史 · 最近 50 条</h2>
          <button onClick={load}>刷新</button>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>类型</th>
                <th>计划时间</th>
                <th>状态</th>
                <th>尝试</th>
                <th>送达 / 错误</th>
              </tr>
            </thead>
            <tbody>
              {deliveries.map((d) => (
                <tr key={d.id}>
                  <td>{names[d.kind] || d.kind}</td>
                  <td>
                    {DateTime.fromISO(d.scheduled_at)
                      .setZone(profile.timezone)
                      .toFormat("dd/MM HH:mm")}
                  </td>
                  <td>
                    {
                      (
                        {
                          sent: "已送达",
                          pending: "等待发送",
                          sending: "发送中",
                          failed: "失败",
                          uncertain: "状态不确定",
                        } as Record<string, string>
                      )[d.state]
                    }
                  </td>
                  <td>{d.attempts}</td>
                  <td>
                    {d.delivered_at
                      ? DateTime.fromISO(d.delivered_at)
                          .setZone(profile.timezone)
                          .toFormat("dd/MM HH:mm")
                      : d.error || "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!deliveries.length && (
          <p className="empty">还没有发送记录。未进行真实端到端通知验证。</p>
        )}
      </section>
    </div>
  );
}
