import { DateTime } from "luxon";
export type CalendarEvent = {
  id: string;
  title: string;
  category: string;
  status: string;
  priority: string;
  start_at: string | null;
  end_at: string | null;
  deadline_at: string | null;
  location?: string | null;
  meeting_url?: string | null;
  preparation?: string | null;
  description?: string | null;
  travel_notes?: string | null;
  mandatory?: boolean;
  recurring?: boolean;
  recurrence_rule?: string | null;
  event_sources?: { url?: string | null; notes?: string | null }[];
};
export const statusLabels: Record<string, string> = {
  confirmed: "已确认",
  booked: "已预约",
  applied: "已申请",
  planned: "计划中",
  considering: "待考虑",
  waiting: "待核实",
  cancelled: "已取消",
  completed: "已完成",
};
export function validZone(zone: string) {
  return DateTime.now().setZone(zone).isValid;
}
export function dueBrief(
  now: string,
  zone: string,
  kind: string,
  localTime: string,
) {
  const d = DateTime.fromISO(now, { zone: "utc" }).setZone(zone);
  return (
    d.isValid &&
    d.toFormat("HH:mm") === localTime.slice(0, 5) &&
    (kind !== "weekly" || d.weekday === 7)
  );
}
export function briefKey(
  user: string,
  kind: string,
  now: string,
  zone: string,
) {
  return `brief:${user}:${kind}:${DateTime.fromISO(now).setZone(zone).toISODate()}`;
}
export function quietUntil(
  now: string,
  zone: string,
  start: string | null,
  end: string | null,
): string | null {
  if (!start || !end || start === end) return null;
  const d = DateTime.fromISO(now).setZone(zone);
  const clock = d.toFormat("HH:mm");
  const a = start.slice(0, 5),
    b = end.slice(0, 5);
  const quiet = a < b ? clock >= a && clock < b : clock >= a || clock < b;
  if (!quiet) return null;
  const [h, m] = b.split(":").map(Number);
  let resume = d.set({ hour: h, minute: m, second: 0, millisecond: 0 });
  if (resume <= d) resume = resume.plus({ days: 1 });
  return resume.toUTC().toISO();
}
export type Conflict = { eventIds: string[]; kind: string; message: string };
export function conflicts(
  events: CalendarEvent[],
  travelMinutes = 45,
): Conflict[] {
  const active = events.filter(
    (e) => !["cancelled", "completed"].includes(e.status),
  );
  const result: Conflict[] = [];
  const timed = active
    .filter((e) => e.start_at && e.end_at)
    .sort((a, b) => Date.parse(a.start_at!) - Date.parse(b.start_at!));
  for (let i = 0; i < timed.length; i++)
    for (let j = i + 1; j < timed.length; j++) {
      const a = timed[i],
        b = timed[j];
      const gap = (Date.parse(b.start_at!) - Date.parse(a.end_at!)) / 60000;
      if (gap < 0)
        result.push({
          eventIds: [a.id, b.id],
          kind: "overlap",
          message: `${a.title} 与 ${b.title} 时间重叠${a.mandatory || b.mandatory ? "，包含必修安排" : ""}。请核实其他场次；已确认预约不会自动移动。`,
        });
      else if (
        gap < travelMinutes &&
        a.location &&
        b.location &&
        a.location !== b.location
      )
        result.push({
          eventIds: [a.id, b.id],
          kind: "travel",
          message: `${a.title} → ${b.title} 仅 ${gap} 分钟；不同地点建议预留 ${travelMinutes} 分钟，实际路线待核实。`,
        });
    }
  for (const e of active)
    if (e.deadline_at)
      for (const t of timed)
        if (
          t.id !== e.id &&
          Date.parse(e.deadline_at) >= Date.parse(t.start_at!) &&
          Date.parse(e.deadline_at) <= Date.parse(t.end_at!)
        )
          result.push({
            eventIds: [e.id, t.id],
            kind: "deadline",
            message: `${e.title} 的截止时间位于 ${t.title} 期间，建议提前提交。`,
          });
  return result;
}
export function briefing(
  kind: string,
  now: string,
  zone: string,
  events: CalendarEvent[],
  tasks: { title: string; due_at?: string | null; completed?: boolean }[] = [],
) {
  const day = DateTime.fromISO(now).setZone(zone);
  const from =
    kind === "weekly"
      ? day.plus({ weeks: 1 }).startOf("week")
      : kind === "tomorrow"
        ? day.plus({ days: 1 }).startOf("day")
        : day.startOf("day");
  const to =
    kind === "weekly" ? from.plus({ weeks: 1 }) : from.plus({ days: 1 });
  const inRange = (x: string | null | undefined) =>
    !!x && DateTime.fromISO(x) >= from && DateTime.fromISO(x) < to;
  const active = events.filter(
    (e) => !["cancelled", "completed"].includes(e.status),
  );
  const selected = active
    .filter((e) => inRange(e.start_at))
    .sort((a, b) => Date.parse(a.start_at!) - Date.parse(b.start_at!));
  const fmt = (x: string) =>
    DateTime.fromISO(x)
      .setZone(zone)
      .toFormat(kind === "weekly" ? "ccc dd/MM HH:mm" : "HH:mm");
  const lines = [
    kind === "weekly"
      ? "🗓 YING OS · 下周计划"
      : kind === "tomorrow"
        ? "🌙 YING OS · 明日准备"
        : "🌅 YING OS · 早安",
    from.toFormat("yyyy-MM-dd") + ` · ${zone}`,
    "",
    "📍 日程",
  ];
  lines.push(
    ...(selected.length
      ? selected.map(
          (e) =>
            `${fmt(e.start_at!)} — ${e.title} · ${e.location || "地点待核实"} [${statusLabels[e.status] || e.status}]${e.travel_notes ? "\n交通：" + e.travel_notes : ""}${e.recurring ? "\n重复规则需核实：" + (e.recurrence_rule || "未知") : ""}`,
        )
      : ["暂无有明确时间的活动"]),
  );
  lines.push(
    "",
    "⚠️ 截止事项",
    ...active
      .filter((e) => inRange(e.deadline_at))
      .map(
        (e) =>
          `${fmt(e.deadline_at!)} — ${e.title} [${statusLabels[e.status]}]`,
      ),
  );
  lines.push(
    "",
    "🎒 准备",
    ...selected
      .filter((e) => e.preparation)
      .map((e) => `${e.title}：${e.preparation}`),
    ...tasks
      .filter(
        (t) => !t.completed && t.due_at && DateTime.fromISO(t.due_at) < to,
      )
      .map((t) => t.title),
  );
  const c = conflicts(active).filter((c) =>
    c.eventIds.some(
      (id) =>
        selected.some((e) => e.id === id) ||
        active.some((e) => e.id === id && inRange(e.deadline_at)),
    ),
  );
  if (c.length) lines.push("", "⚠️ 时间冲突", ...c.map((x) => x.message));
  const pending = active.filter(
    (e) =>
      ["applied", "considering", "waiting", "planned"].includes(e.status) &&
      (inRange(e.start_at) || inRange(e.deadline_at)),
  );
  if (pending.length)
    lines.push(
      "",
      "📝 待确认",
      ...pending.map((e) => `${e.title}：${statusLabels[e.status]}`),
    );
  const sources = [
    ...new Set(
      active
        .filter((e) => inRange(e.start_at) || inRange(e.deadline_at))
        .flatMap((e) => [
          e.meeting_url,
          ...(e.event_sources || []).map((s) => s.url),
        ])
        .filter((x): x is string => !!x && /^https?:\/\//.test(x)),
    ),
  ];
  if (sources.length) lines.push("", "🔗 原始来源 / 预约", ...sources);
  if (active.some((e) => !e.start_at && !e.deadline_at))
    lines.push("", "待核实时间的记录请到 AI 收件箱 / 日历检查。");
  return lines.join("\n");
}
export function splitMessage(text: string, limit = 3500): string[] {
  const chars = Array.from(text);
  const parts: string[] = [];
  let chunk = "";
  for (const c of chars) {
    if ((chunk + c).length > limit) {
      parts.push(chunk);
      chunk = "";
    }
    chunk += c;
  }
  if (chunk) parts.push(chunk);
  return parts;
}
export function authorizedWebhook(
  expected: string | undefined,
  actual: string | null,
  chatType: string,
) {
  return (
    !!expected && !!actual && expected === actual && chatType === "private"
  );
}

// Group overlapping cards into lanes so a clash cannot hide another booking.
export function layoutDay<T extends CalendarEvent>(
  events: T[],
  day: string,
  zone: string,
) {
  const from = DateTime.fromISO(day, { zone }).startOf("day"),
    to = from.plus({ days: 1 });
  const items = events
    .filter(
      (e) =>
        e.start_at &&
        DateTime.fromISO(e.start_at) < to &&
        DateTime.fromISO(e.end_at || e.start_at) >= from,
    )
    .map((event) => {
      const s = DateTime.fromISO(event.start_at!).setZone(zone),
        e = event.end_at
          ? DateTime.fromISO(event.end_at).setZone(zone)
          : s.plus({ minutes: 45 });
      const start = s < from ? 0 : s.hour * 60 + s.minute;
      const end = e >= to ? 1440 : e.hour * 60 + e.minute;
      return {
        event,
        start,
        end: Math.max(start + 50, end),
        lane: 0,
        lanes: 1,
      };
    })
    .sort((a, b) => a.start - b.start || b.end - a.end);
  let group: typeof items = [];
  let groupEnd = -1;
  const finish = () => {
    const ends: number[] = [];
    for (const item of group) {
      let lane = ends.findIndex((end) => end <= item.start);
      if (lane < 0) lane = ends.length;
      ends[lane] = item.end;
      item.lane = lane;
    }
    for (const item of group) item.lanes = ends.length;
  };
  for (const item of items) {
    if (item.start >= groupEnd) {
      finish();
      group = [];
      groupEnd = -1;
    }
    group.push(item);
    groupEnd = Math.max(groupEnd, item.end);
  }
  finish();
  return items;
}
