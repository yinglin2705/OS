"use client";
import { useEffect, useMemo, useState, useRef } from "react";
import { DateTime } from "luxon";
import { browserDB, configured } from "@/lib/supabase";
import {
  conflicts,
  layoutDay,
  statusLabels,
  type CalendarEvent,
} from "@/supabase/functions/_shared/core";
import Settings from "./Settings";
type Event = Omit<CalendarEvent, "event_sources"> & {
  version: number;
  timezone: string;
  course?: string;
  notes?: string;
  attachments?: string[];
  verified_at?: string;
  event_sources?: {
    url?: string | null;
    notes?: string | null;
    source_type?: string;
    original_record?: unknown;
  }[];
};
type Proposal = {
  id: string;
  payload: Record<string, unknown>;
  event_id?: string;
  warnings: string[];
  source: {
    notes?: string;
    url?: string;
    source_type?: string;
    original_record?: unknown;
  };
};
type Task = {
  id: string;
  title: string;
  reason: string;
  due_at: string;
  completed: boolean;
};
type History = {
  id: string;
  created_at: string;
  event_id: string;
  old_record?: Record<string, unknown>;
  new_record: Record<string, unknown>;
};
const categories: Record<string, string> = {
  academic: "学术",
  technical: "技术训练",
  career: "职业",
  social: "社交",
  personal: "个人",
  other: "其他",
};
const dt = (value: string, zone: string) =>
  DateTime.fromISO(value).setZone(zone);
export default function Dashboard({
  initialTab = "calendar",
}: {
  initialTab?: string;
}) {
  const timetable = useRef<HTMLDivElement>(null);
  const approvalInFlight = useRef(false);
  const [approvalProgress, setApprovalProgress] = useState("");
  const [ready, setReady] = useState(false),
    [user, setUser] = useState<string | null>(null),
    [loading, setLoading] = useState(true),
    [message, setMessage] = useState(""),
    [email, setEmail] = useState("");
  const [tab, setTab] = useState(initialTab),
    [events, setEvents] = useState<Event[]>([]),
    [proposals, setProposals] = useState<Proposal[]>([]),
    [tasks, setTasks] = useState<Task[]>([]),
    [history, setHistory] = useState<History[]>([]);
  const [zone, setZone] = useState("Europe/London"),
    [anchor, setAnchor] = useState(
      DateTime.now().setZone("Europe/London").startOf("day"),
    ),
    [view, setView] = useState("week"),
    [category, setCategory] = useState("all"),
    [selected, setSelected] = useState<Event | null>(null),
    [edit, setEdit] = useState<Event | true | null>(null),
    [text, setText] = useState(""),
    [busy, setBusy] = useState(false),
    [dark, setDark] = useState(false);
  useEffect(() => {
    setReady(configured());
    setDark(localStorage.getItem("ying-theme") === "dark");
    if (!configured()) {
      setLoading(false);
      return;
    }
    const db = browserDB();
    db.auth.getUser().then(({ data }) => {
      setUser(data.user?.id || null);
      setLoading(false);
    });
    const {
      data: { subscription },
    } = db.auth.onAuthStateChange((_e, s) => setUser(s?.user.id || null));
    return () => subscription.unsubscribe();
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    localStorage.setItem("ying-theme", dark ? "dark" : "light");
  }, [dark]);
  async function refresh() {
    if (!user) return;
    const db = browserDB();
    const result = await Promise.all([
      db
        .from("events")
        .select("*,event_sources(*)")
        .order("start_at", { ascending: true }),
      db
        .from("change_proposals")
        .select("*")
        .eq("state", "pending")
        .order("created_at", { ascending: false }),
      db.from("preparation_tasks").select("*").order("due_at"),
      db
        .from("event_status_history")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(100),
      db.from("users").select("timezone").single(),
    ]);
    const error = result.find((r) => r.error)?.error;
    if (error) {
      setMessage("数据读取失败：" + error.message);
      return;
    }
    setEvents(result[0].data || []);
    setProposals(result[1].data || []);
    setTasks(result[2].data || []);
    setHistory(result[3].data || []);
    if (result[4].data?.timezone) {
      setZone(result[4].data.timezone);
      setAnchor((a) => a.setZone(result[4].data!.timezone));
    }
  }
  useEffect(() => {
    if (user) void refresh();
  }, [user]);
  useEffect(() => {
    if (timetable.current) timetable.current.scrollTop = 7 * 72;
  }, [tab, view, user]); // Reload after each controlled mutation.
  const visible = useMemo(
    () => events.filter((e) => category === "all" || e.category === category),
    [events, category],
  );
  const issues = useMemo(() => conflicts(events), [events]);
  const today = DateTime.now().setZone(zone);
  const deadlines = events
    .filter(
      (e) =>
        e.deadline_at &&
        !["cancelled", "completed"].includes(e.status) &&
        dt(e.deadline_at, zone) >= today.startOf("day"),
    )
    .sort((a, b) => a.deadline_at!.localeCompare(b.deadline_at!));
  async function request(body: FormData | Record<string, unknown>) {
    setBusy(true);
    try {
      const res = await fetch("/api/ingest", {
        method: "POST",
        headers:
          body instanceof FormData
            ? undefined
            : { "Content-Type": "application/json" },
        body: body instanceof FormData ? body : JSON.stringify(body),
      });
      const data = await res.json();
      setMessage(data.error || data.message);
      if (res.ok) {
        await refresh();
        setTab("inbox");
        setEdit(null);
        setText("");
      }
    } catch {
      setMessage("网络请求失败，请重试");
    } finally {
      setBusy(false);
    }
  }
  async function approve(id: string, accept: boolean) {
    if (approvalInFlight.current) return;
    approvalInFlight.current = true;
    setBusy(true);
    try {
      const { error } = await browserDB().rpc("confirm_proposal", {
        proposal_id: id,
        accept,
      });
      setMessage(
        error
          ? "确认失败：" + error.message
          : accept
            ? "已更新日历，保留原来源与修改历史"
            : "已忽略提议",
      );
    } catch {
      setMessage("网络中断，请刷新核对结果后再操作");
    } finally {
      try {
        await refresh();
      } finally {
        approvalInFlight.current = false;
        setBusy(false);
      }
    }
  }
  async function approveAll() {
    if (busy || approvalInFlight.current || !proposals.length) return;
    const snapshot = [...proposals];
    const additions = snapshot.filter((p) => !p.event_id).length;
    const warnings = snapshot.filter((p) => p.warnings.length).length;
    if (
      !window.confirm(
        `确认全部 ${snapshot.length} 条更改？\n新增 ${additions} 条，修改 ${snapshot.length - additions} 条，其中 ${warnings} 条有待核实提示。\n\n仅将提议写入日历，不代表已核实来源或已预约；未知时间、拟报名和备选状态保持不变。`,
      )
    )
      return;
    approvalInFlight.current = true;
    setBusy(true);
    let completed = 0;
    let stopped = false;
    try {
      const db = browserDB();
      for (const proposal of snapshot) {
        setApprovalProgress(`正在确认 ${completed + 1} / ${snapshot.length}…`);
        const { error } = await db.rpc("confirm_proposal", {
          proposal_id: proposal.id,
          accept: true,
        });
        if (error) {
          stopped = true;
          break;
        }
        completed++;
      }
      setMessage(
        stopped
          ? `已确认 ${completed} 条后停止：有记录无法确认，请刷新检查剩余提议；已成功的更改保留。`
          : `已确认全部 ${completed} 条更改，保留原状态、来源与修改历史`,
      );
    } catch {
      setMessage(
        `网络中断，已收到 ${completed} 条成功结果；最后一条结果尚未确认，请刷新核对后继续。`,
      );
    } finally {
      try {
        await refresh();
      } finally {
        setApprovalProgress("");
        approvalInFlight.current = false;
        setBusy(false);
      }
    }
  }
  async function login(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const { error } = await browserDB().auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${location.origin}/auth/callback` },
    });
    setMessage(error ? error.message : "登录链接已发至邮箱，请检查收件箱。");
    setBusy(false);
  }
  function exportICS() {
    const escape = (s: string) =>
      s
        .replaceAll("\\", "\\\\")
        .replaceAll("\n", "\\n")
        .replaceAll(",", "\\,")
        .replaceAll(";", "\\;");
    const utc = (s: string) =>
      DateTime.fromISO(s).toUTC().toFormat("yyyyMMdd'T'HHmmss'Z'");
    const lines = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//YING OS//ZH",
      "CALSCALE:GREGORIAN",
    ];
    for (const e of events) {
      if (!e.start_at || !e.end_at || e.status === "cancelled") continue;
      lines.push(
        "BEGIN:VEVENT",
        `UID:${e.id}@ying-os`,
        `DTSTAMP:${utc(new Date().toISOString())}`,
        `DTSTART:${utc(e.start_at)}`,
        `DTEND:${utc(e.end_at)}`,
        `SUMMARY:${escape(e.title)}`,
        `DESCRIPTION:${escape(`[${statusLabels[e.status]}]\n${e.description || ""}\n${e.event_sources?.map((s) => s.url || s.notes).join("\n") || ""}`)}`,
        `LOCATION:${escape(e.location || "")}`,
        "END:VEVENT",
      );
    }
    lines.push("END:VCALENDAR");
    const blob = new Blob([lines.join("\r\n")], { type: "text/calendar" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "ying-os.ics";
    a.click();
    URL.revokeObjectURL(url);
    setMessage(
      "已导出有明确开始与结束时间的活动；未知时间、截止事项和重复展开不包含在 ICS 中。",
    );
  }
  const card = (e: Event) => (
    <button
      key={e.id}
      className={`event-card ${e.category} ${e.status === "cancelled" ? "cancelled" : ""}`}
      onClick={() => setSelected(e)}
    >
      <span className="event-time">
        {e.start_at ? dt(e.start_at, zone).toFormat("HH:mm") : "时间待核实"}
        {e.end_at ? "–" + dt(e.end_at, zone).toFormat("HH:mm") : ""}
      </span>
      <strong>{e.title}</strong>
      <span>{e.location || "地点待核实"}</span>
      <small>
        {statusLabels[e.status]}
        {e.mandatory ? " · 必修" : ""}
      </small>
    </button>
  );
  if (loading) return <main className="welcome">正在连接你的日历…</main>;
  if (!user)
    return (
      <main className="welcome">
        <div className="brand">
          YING <span>OS</span>
        </div>
        <p className="eyebrow">ACADEMIC · CREATIVE · PERSONAL</p>
        <h1>给忙碌留一点空间。</h1>
        <p>你的课程、创作与生活，在一个有来源的日历里。</p>
        <div className="welcome-card">
          {ready ? (
            <form onSubmit={login}>
              <label>
                使用邮箱安全登录
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  placeholder="you@ucl.ac.uk"
                />
              </label>
              <button className="primary" disabled={busy}>
                发送登录链接
              </button>
              <p className="muted">
                通过 Supabase 邮箱验证登录，数据仅本人可见。
              </p>
            </form>
          ) : (
            <>
              <h2>先连接你的数据库</h2>
              <p>
                请配置 NEXT_PUBLIC_SUPABASE_URL 与
                NEXT_PUBLIC_SUPABASE_ANON_KEY，并执行 Supabase SQL
                迁移。这里不会用虚构日程替代真实数据。
              </p>
              <p className="muted">完整部署步骤见仓库 README。</p>
            </>
          )}
          {message && <p role="status">{message}</p>}
        </div>
      </main>
    );
  const week = anchor.startOf("week");
  const days = Array.from({ length: view === "day" ? 1 : 7 }, (_, i) =>
    view === "day" ? anchor : week.plus({ days: i }),
  );
  return (
    <div className="shell">
      <aside className="sidebar">
        <a className="brand" href="/">
          YING <span>OS</span>
        </a>
        <p className="eyebrow">我的学术与创作日历</p>
        <nav>
          {[
            ["calendar", "◷", "日历"],
            ["inbox", "↳", "AI 收件箱"],
            ["preparation", "✓", "准备清单"],
            ["history", "↺", "修改历史"],
            ["settings", "⚙", "设置与通知"],
          ].map(([key, icon, label]) => (
            <button
              className={tab === key ? "active" : ""}
              key={key}
              onClick={() => setTab(key)}
            >
              <span>{icon}</span>
              {label}
              {key === "inbox" && proposals.length > 0 && (
                <b>{proposals.length}</b>
              )}
            </button>
          ))}
          <a className="nav-search" href="/search">
            ⌕ 搜索与关联
          </a>
        </nav>
        <div className="sidebar-foot">
          <p>DFPI · Bartlett</p>
          <p>{zone}</p>
          <button onClick={() => setDark(!dark)}>
            {dark ? "☀ 浅色模式" : "☾ 深色模式"}
          </button>
          <button onClick={() => browserDB().auth.signOut()}>退出登录</button>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div>
            <p className="eyebrow">{today.toFormat("cccc, dd MMMM yyyy")}</p>
            <h1>
              {tab === "calendar"
                ? "每一天，清晰一点。"
                : tab === "inbox"
                  ? "信息先核实，再安排。"
                  : tab === "preparation"
                    ? "准备好，就少一点慌张。"
                    : tab === "history"
                      ? "每一次更改，都有记录。"
                      : "你的通知，由你掌控。"}
            </h1>
          </div>
          <button className="primary" onClick={() => setEdit(true)}>
            ＋ 新建活动
          </button>
        </header>
        {message && (
          <div className="notice" role="status">
            {message}
            <button aria-label="关闭提示" onClick={() => setMessage("")}>
              ×
            </button>
          </div>
        )}
        {tab === "calendar" && (
          <>
            <div className="summary">
              <section>
                <p className="eyebrow">TODAY · 今日</p>
                <h2>
                  {
                    events.filter(
                      (e) =>
                        e.start_at &&
                        dt(e.start_at, zone).hasSame(today, "day") &&
                        !["cancelled", "completed"].includes(e.status),
                    ).length
                  }{" "}
                  个安排
                </h2>
                <p className="muted">包含待确认活动，请留意状态</p>
              </section>
              <section>
                <p className="eyebrow">DEADLINES · 截止</p>
                <h2>{deadlines[0]?.title || "暂无明确截止事项"}</h2>
                <p className="muted">
                  {deadlines[0]?.deadline_at
                    ? dt(deadlines[0].deadline_at, zone).toFormat(
                        "dd MMM · HH:mm",
                      )
                    : "导入你的课程与任务后显示"}
                </p>
              </section>
              <section>
                <p className="eyebrow">FOCUS · 准备</p>
                <h2>{tasks.filter((t) => !t.completed).length} 项待完成</h2>
                <p className="muted">
                  {issues.length
                    ? `⚠ ${issues.length} 个潜在冲突`
                    : "让准备提前一点"}
                </p>
              </section>
            </div>
            <section className="calendar-panel">
              <div className="toolbar">
                <div className="date-nav">
                  <button
                    aria-label="上一个时间段"
                    onClick={() =>
                      setAnchor(
                        anchor.minus(
                          view === "month"
                            ? { months: 1 }
                            : view === "day"
                              ? { days: 1 }
                              : { weeks: 1 },
                        ),
                      )
                    }
                  >
                    ‹
                  </button>
                  <h2>
                    {anchor.toFormat("yyyy 年 M 月")}
                    {view === "week" && (
                      <small>
                        {" "}
                        · {week.toFormat("d")}–
                        {week.plus({ days: 6 }).toFormat("d")}
                      </small>
                    )}
                  </h2>
                  <button
                    aria-label="下一个时间段"
                    onClick={() =>
                      setAnchor(
                        anchor.plus(
                          view === "month"
                            ? { months: 1 }
                            : view === "day"
                              ? { days: 1 }
                              : { weeks: 1 },
                        ),
                      )
                    }
                  >
                    ›
                  </button>
                  <button onClick={() => setAnchor(today.startOf("day"))}>
                    今天
                  </button>
                </div>
                <div className="segmented">
                  {[
                    ["day", "日"],
                    ["week", "周"],
                    ["month", "月"],
                    ["agenda", "列表"],
                  ].map(([key, label]) => (
                    <button
                      className={view === key ? "active" : ""}
                      key={key}
                      onClick={() => setView(key)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="filters">
                <button
                  className={category === "all" ? "chosen" : ""}
                  onClick={() => setCategory("all")}
                >
                  全部
                </button>
                {Object.entries(categories).map(([key, label]) => (
                  <button
                    className={category === key ? "chosen" : ""}
                    key={key}
                    onClick={() => setCategory(key)}
                  >
                    <i className={key} />
                    {label}
                  </button>
                ))}
                <button onClick={exportICS}>导出 ICS</button>
              </div>
              {(view === "week" || view === "day") && (
                <div
                  ref={timetable}
                  className="timetable"
                  style={{
                    gridTemplateColumns: `52px repeat(${days.length}, minmax(125px,1fr))`,
                  }}
                >
                  <div className="time-column">
                    <div className="day-heading" />
                    {Array.from({ length: 24 }, (_, i) => (
                      <div className="time-label" key={i}>
                        {String(i).padStart(2, "0")}:00
                      </div>
                    ))}
                  </div>
                  {days.map((day) => (
                    <div className="day-column" key={day.toISO()}>
                      <div
                        className={
                          "day-heading " +
                          (day.hasSame(today, "day") ? "is-today" : "")
                        }
                      >
                        <small>{day.setLocale("zh").toFormat("ccc")}</small>
                        <b>{day.day}</b>
                      </div>
                      <div className="day-hours">
                        {Array.from({ length: 24 }, (_, i) => (
                          <div className="hour-line" key={i} />
                        ))}
                        {layoutDay(visible, day.toISODate()!, zone).map(
                          ({ event: e, start, end, lane, lanes }) => (
                            <div
                              className="positioned-event"
                              key={e.id}
                              style={{
                                top: start * 1.2,
                                height:
                                  Math.min(end - start, 1440 - start) * 1.2,
                                left: `calc(${(lane / lanes) * 100}% + 3px)`,
                                right: "auto",
                                width: `calc(${100 / lanes}% - 6px)`,
                              }}
                            >
                              {card(e)}
                            </div>
                          ),
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {view === "month" && (
                <div className="month-grid">
                  {Array.from({ length: 42 }, (_, i) =>
                    anchor.startOf("month").startOf("week").plus({ days: i }),
                  ).map((day) => (
                    <div
                      className={
                        "month-day " +
                        (day.month !== anchor.month ? "outside" : "")
                      }
                      key={day.toISO()}
                    >
                      <button
                        className={
                          day.hasSame(today, "day") ? "today-date" : ""
                        }
                        onClick={() => {
                          setAnchor(day);
                          setView("day");
                        }}
                      >
                        {day.toFormat("ccc d")}
                      </button>
                      {visible
                        .filter(
                          (e) =>
                            e.start_at &&
                            dt(e.start_at, zone).hasSame(day, "day"),
                        )
                        .map(card)}
                    </div>
                  ))}
                </div>
              )}
              {view === "agenda" && (
                <div className="agenda">
                  {visible.length ? (
                    visible
                      .sort((a, b) =>
                        (a.start_at || a.deadline_at || "z").localeCompare(
                          b.start_at || b.deadline_at || "z",
                        ),
                      )
                      .map((e) => (
                        <div key={e.id}>
                          <p>
                            {e.start_at
                              ? dt(e.start_at, zone).toFormat("yyyy-MM-dd")
                              : e.deadline_at
                                ? "截止 " +
                                  dt(e.deadline_at, zone).toFormat(
                                    "yyyy-MM-dd HH:mm",
                                  )
                                : "日期待核实"}
                          </p>
                          {card(e)}
                        </div>
                      ))
                  ) : (
                    <Empty text="还没有日程。新建活动，或从 AI 收件箱导入文件。" />
                  )}
                </div>
              )}
            </section>
            <div className="bottom-grid">
              <section className="panel">
                <h2>即将截止</h2>
                {deadlines.slice(0, 6).map((e) => (
                  <button
                    className="list-row"
                    key={e.id}
                    onClick={() => setSelected(e)}
                  >
                    <strong>{e.title}</strong>
                    <span>
                      {dt(e.deadline_at!, zone).toFormat("dd/MM HH:mm")}
                    </span>
                  </button>
                ))}
                {!deadlines.length && (
                  <Empty text="暂无明确截止时间。日期不完整的记录不会被自动推断。" />
                )}
              </section>
              <section className="panel">
                <h2>待报名 / 确认</h2>
                {events
                  .filter((e) =>
                    ["applied", "planned", "considering", "waiting"].includes(
                      e.status,
                    ),
                  )
                  .slice(0, 6)
                  .map((e) => (
                    <button
                      className="list-row"
                      key={e.id}
                      onClick={() => setSelected(e)}
                    >
                      <strong>{e.title}</strong>
                      <span>{statusLabels[e.status]}</span>
                    </button>
                  ))}
                <p className="muted">第一志愿与申请不等于确认预约。</p>
              </section>
              <section className="panel">
                <h2>潜在冲突</h2>
                {issues.slice(0, 5).map((c, i) => (
                  <p className="conflict" key={i}>
                    {c.message}
                  </p>
                ))}
                {!issues.length && (
                  <Empty text="暂无已知冲突；未知时间无法检查。跨地点预留时间是建议，尚未核实路线。" />
                )}
              </section>
            </div>
            {visible.some((e) => !e.start_at) && (
              <p className="muted">
                无明确开始时间的活动与截止事项请在“列表”视图查看。
              </p>
            )}
          </>
        )}
        {tab === "inbox" && (
          <>
            <section className="panel intake">
              <h2>把新信息交给日历</h2>
              <p className="muted">
                支持粘贴对话、CSV、Excel、ICS（含 Google Calendar 导出）及
                ChatGPT JSON 导出。可逐条审核，也可全部确认；原始状态保持不变。
              </p>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void request({ text });
                }}
              >
                <textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder="例如：这场 Model Photography Workshop 先标记为待考虑"
                  maxLength={20000}
                  required
                />
                <button className="primary" disabled={busy}>
                  生成修改提议
                </button>
              </form>
              <label className="file-upload">
                导入文件（≤4 MB / 500 条）
                <input
                  type="file"
                  accept=".csv,.xlsx,.ics,.json"
                  disabled={busy}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) {
                      const form = new FormData();
                      form.set("file", file);
                      void request(form);
                    }
                    e.target.value = "";
                  }}
                />
              </label>
              <p className="muted">
                当前使用可解释的规则解析；不完整日期、重复课程和无法唯一匹配的消息需要人工核实。
              </p>
            </section>
            <h2>等待你确认 · {proposals.length}</h2>
            {proposals.length > 0 && (
              <section className="panel">
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() => void approveAll()}
                >
                  全部确认（{proposals.length} 条）
                </button>
                <p className="muted">
                  写入日历并保留原状态和来源；有待核实提示{" "}
                  {proposals.filter((p) => p.warnings.length).length}{" "}
                  条。确认更改不代表确认出席。
                </p>
                <p role="status" aria-live="polite">
                  {approvalProgress}
                </p>
              </section>
            )}
            {proposals.map((p) => (
              <section className="panel proposal" key={p.id}>
                <h3>
                  {String(
                    p.payload.title ||
                      events.find((e) => e.id === p.event_id)?.title ||
                      "更新活动",
                  )}
                </h3>
                <p>
                  {p.event_id ? "修改现有活动" : "新增活动"} · 来源：
                  {p.source.source_type}
                </p>
                <dl>
                  {Object.entries(p.payload)
                    .filter(([, v]) => v !== null && v !== "" && v !== false)
                    .map(([k, v]) => (
                      <div key={k}>
                        <dt>{k}</dt>
                        <dd>
                          {typeof v === "object"
                            ? JSON.stringify(v)
                            : String(v)}
                        </dd>
                      </div>
                    ))}
                </dl>
                {p.warnings.map((w, i) => (
                  <p className="conflict" key={i}>
                    ⚠ {w}
                  </p>
                ))}
                <details>
                  <summary>原始信息</summary>
                  <pre>
                    {p.source.notes}
                    {JSON.stringify(p.source.original_record, null, 2)}
                  </pre>
                </details>
                <div className="actions">
                  <button
                    className="primary"
                    disabled={busy}
                    onClick={() => approve(p.id, true)}
                  >
                    确认更改
                  </button>
                  <button disabled={busy} onClick={() => approve(p.id, false)}>
                    忽略
                  </button>
                </div>
              </section>
            ))}
            {!proposals.length && (
              <Empty text="收件箱已清空。导入不会自动改变已确认日程。" />
            )}
          </>
        )}
        {tab === "preparation" && (
          <section className="panel">
            <h2>准备清单</h2>
            <p className="muted">
              确认或预约活动后自动生成准备建议。通知需在设置页批准，可更改时间、延后或停用。
            </p>
            {tasks.map((t) => (
              <div className="task" key={t.id}>
                <input
                  aria-label={"完成 " + t.title}
                  type="checkbox"
                  checked={t.completed}
                  onChange={async (e) => {
                    const { error } = await browserDB()
                      .from("preparation_tasks")
                      .update({ completed: e.target.checked })
                      .eq("id", t.id);
                    if (error) setMessage(error.message);
                    await refresh();
                  }}
                />
                <div>
                  <strong className={t.completed ? "done" : ""}>
                    {t.title}
                  </strong>
                  <p>{t.reason}</p>
                  <small>
                    {t.due_at
                      ? dt(t.due_at, zone).toFormat("dd/MM HH:mm")
                      : "日期待核实"}
                  </small>
                </div>
              </div>
            ))}
            {!tasks.length && (
              <Empty text="确认有明确时间的活动后，这里会生成准备任务。" />
            )}
          </section>
        )}
        {tab === "history" && (
          <section className="panel">
            <h2>最近 100 次修改</h2>
            {history.map((h) => (
              <details className="history-row" key={h.id}>
                <summary>
                  {String(h.new_record.title)} ·{" "}
                  {dt(h.created_at, zone).toFormat("dd/MM HH:mm")} ·{" "}
                  {h.old_record ? "更新" : "新建"}
                </summary>
                <pre>
                  {JSON.stringify(
                    { 之前: h.old_record, 之后: h.new_record },
                    null,
                    2,
                  )}
                </pre>
              </details>
            ))}
            {!history.length && (
              <Empty text="确认更改后会留下版本记录，原来源不会被覆盖。" />
            )}
          </section>
        )}
        {tab === "settings" && (
          <Settings userId={user} onMessage={setMessage} onRefresh={refresh} />
        )}
      </main>
      {selected && (
        <div className="modal-backdrop" onClick={() => setSelected(null)}>
          <section
            role="dialog"
            aria-modal="true"
            aria-label="活动详情"
            className="modal"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="close"
              aria-label="关闭"
              onClick={() => setSelected(null)}
            >
              ×
            </button>
            <p className="eyebrow">
              {categories[selected.category]} · {statusLabels[selected.status]}
            </p>
            <h2>{selected.title}</h2>
            <a
              className="primary board-open"
              href={`/events/${selected.id}/board`}
            >
              打开事件看板 ↗
            </a>
            <dl>
              {[
                [
                  "开始",
                  selected.start_at
                    ? dt(selected.start_at, zone).toFormat("yyyy-MM-dd HH:mm")
                    : "待核实",
                ],
                [
                  "结束",
                  selected.end_at
                    ? dt(selected.end_at, zone).toFormat("yyyy-MM-dd HH:mm")
                    : "待核实",
                ],
                [
                  "截止",
                  selected.deadline_at
                    ? dt(selected.deadline_at, zone).toFormat(
                        "yyyy-MM-dd HH:mm",
                      )
                    : "无明确截止时间",
                ],
                ["地点", selected.location || "待核实"],
                ["交通", selected.travel_notes || "待核实"],
                ["准备", selected.preparation || "待核实"],
                ["课程 / 项目", selected.course || "未关联"],
                [
                  "重复",
                  selected.recurring ? "是；当前未自动展开重复规则" : "否",
                ],
                [
                  "最近来源核实",
                  selected.verified_at
                    ? dt(selected.verified_at, zone).toFormat(
                        "yyyy-MM-dd HH:mm",
                      )
                    : "尚未核实",
                ],
              ].map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
            <p>{selected.description}</p>
            {selected.meeting_url && (
              <a href={selected.meeting_url} target="_blank" rel="noreferrer">
                在线会议链接 ↗
              </a>
            )}
            <h3>原始来源</h3>
            {selected.event_sources?.length ? (
              selected.event_sources.map((s, i) => (
                <div className="source" key={i}>
                  <p>
                    {s.source_type} · {s.notes}
                  </p>
                  {s.url && /^https?:\/\//.test(s.url) && (
                    <a href={s.url} target="_blank" rel="noreferrer">
                      {s.url} ↗
                    </a>
                  )}
                  {s.original_record != null && (
                    <details>
                      <summary>原始记录</summary>
                      <pre>{JSON.stringify(s.original_record, null, 2)}</pre>
                    </details>
                  )}
                </div>
              ))
            ) : (
              <p className="muted">尚未提供来源链接</p>
            )}
            <p>{selected.notes}</p>
            <button
              className="primary"
              onClick={() => {
                setEdit(selected);
                setSelected(null);
              }}
            >
              编辑活动
            </button>
          </section>
        </div>
      )}
      {edit && (
        <EventEditor
          event={edit === true ? null : edit}
          zone={zone}
          busy={busy}
          onClose={() => setEdit(null)}
          onSave={request}
        />
      )}
    </div>
  );
}
function Empty({ text }: { text: string }) {
  return <p className="empty">{text}</p>;
}
function EventEditor({
  event,
  zone,
  busy,
  onClose,
  onSave,
}: {
  event: Event | null;
  zone: string;
  busy: boolean;
  onClose: () => void;
  onSave: (body: Record<string, unknown>) => Promise<void>;
}) {
  const local = (value?: string | null) =>
    value ? dt(value, zone).toFormat("yyyy-MM-dd'T'HH:mm") : "";
  const fields = [
    ["title", "活动名称", "text"],
    ["start_at", "开始时间（未知可留空）", "datetime-local"],
    ["end_at", "结束时间（未知可留空）", "datetime-local"],
    ["deadline_at", "截止时间（与活动时间独立）", "datetime-local"],
    ["location", "地点", "text"],
    ["meeting_url", "会议链接", "url"],
    ["course", "课程 / 项目", "text"],
    ["preparation", "准备要求", "text"],
    ["travel_notes", "交通备注", "text"],
    ["source_url", "来源链接", "url"],
    ["source_notes", "来源说明", "text"],
  ];
  return (
    <div className="modal-backdrop">
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="编辑活动"
      >
        <button className="close" aria-label="关闭" onClick={onClose}>
          ×
        </button>
        <h2>{event ? "编辑活动" : "新建活动"}</h2>
        <p className="muted">
          时间使用 {zone}。保存后仍须在收件箱确认；缺失信息不会自动补全。
        </p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            const payload: Record<string, unknown> = {
              title: form.get("title"),
              status: form.get("status"),
              category: form.get("category"),
              priority: form.get("priority"),
              timezone: zone,
              mandatory: form.get("mandatory") === "on",
              recurring: event?.recurring || false,
              recurrence_rule: event?.recurrence_rule || null,
              attachments: event?.attachments || [],
              notes: event?.notes || null,
            };
            for (const key of ["start_at", "end_at", "deadline_at"]) {
              const raw = String(form.get(key) || "");
              if (raw) {
                const d = DateTime.fromISO(raw, { zone });
                if (
                  !d.isValid ||
                  d.toFormat("yyyy-MM-dd'T'HH:mm") !== raw ||
                  d.getPossibleOffsets().length > 1
                ) {
                  alert("此本地时间不存在或存在夏令时歧义，请选择另一个时间。");
                  return;
                }
                payload[key] = d.toUTC().toISO();
              } else payload[key] = null;
            }
            for (const key of [
              "location",
              "meeting_url",
              "course",
              "preparation",
              "travel_notes",
              "description",
            ])
              payload[key] = form.get(key) || null;
            await onSave({
              event: payload,
              event_id: event?.id,
              source_url: form.get("source_url"),
              source_notes: form.get("source_notes"),
            });
          }}
        >
          <div className="form-grid">
            {fields.map(([key, label, type]) => (
              <label key={key}>
                {label}
                <input
                  name={key}
                  type={type}
                  required={key === "title"}
                  defaultValue={
                    key.endsWith("_at")
                      ? local(event?.[key as "start_at"])
                      : String(event?.[key as keyof Event] || "")
                  }
                  maxLength={key === "title" ? 200 : undefined}
                />
              </label>
            ))}
            <label>
              状态
              <select
                name="status"
                defaultValue={event?.status || "considering"}
              >
                {Object.entries(statusLabels).map(([v, l]) => (
                  <option value={v} key={v}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
            <label>
              类别
              <select
                name="category"
                defaultValue={event?.category || "academic"}
              >
                {Object.entries(categories).map(([v, l]) => (
                  <option value={v} key={v}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
            <label>
              优先级
              <select
                name="priority"
                defaultValue={event?.priority || "normal"}
              >
                <option value="high">高</option>
                <option value="normal">正常</option>
                <option value="low">低</option>
              </select>
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                name="mandatory"
                defaultChecked={event?.mandatory}
              />
              必修 / 必须参加
            </label>
          </div>
          <label>
            描述
            <textarea
              name="description"
              defaultValue={event?.description || ""}
            />
          </label>
          <button className="primary" disabled={busy}>
            保存为待确认更改
          </button>
        </form>
      </section>
    </div>
  );
}
