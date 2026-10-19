import { DateTime } from "luxon";
import { z } from "zod";
import type { CalendarEvent } from "../supabase/functions/_shared/core";
const url = z
  .string()
  .url()
  .refine((x) => /^https?:\/\//.test(x), "Only HTTP(S) links")
  .nullable()
  .optional();
const instant = z.string().datetime({ offset: true }).nullable().optional();
export const eventInput = z
  .object({
    title: z.string().trim().min(1).max(200),
    category: z
      .enum(["academic", "technical", "career", "social", "personal", "other"])
      .default("academic"),
    status: z
      .enum([
        "confirmed",
        "conflict",
        "booked",
        "applied",
        "planned",
        "considering",
        "waiting",
        "cancelled",
        "completed",
      ])
      .default("considering"),
    priority: z.enum(["high", "normal", "low"]).default("normal"),
    start_at: instant,
    end_at: instant,
    deadline_at: instant,
    timezone: z
      .string()
      .refine((x) => DateTime.now().setZone(x).isValid)
      .default("Europe/London"),
    location: z.string().max(1000).nullable().optional(),
    meeting_url: url,
    travel_notes: z.string().max(2000).nullable().optional(),
    description: z.string().max(10000).nullable().optional(),
    preparation: z.string().max(4000).nullable().optional(),
    course: z.string().max(500).nullable().optional(),
    notes: z.string().max(10000).nullable().optional(),
    mandatory: z.boolean().default(false),
    recurring: z.boolean().default(false),
    recurrence_rule: z.string().max(1000).nullable().optional(),
    attachments: z.array(url).max(20).default([]),
  })
  .strict()
  .superRefine((e, ctx) => {
    if (
      e.end_at &&
      (!e.start_at || Date.parse(e.end_at) <= Date.parse(e.start_at))
    )
      ctx.addIssue({ code: "custom", message: "结束时间须晚于开始时间" });
  });
export type Proposal = {
  event_id?: string;
  expected_version?: number;
  payload: Record<string, unknown>;
  source: Record<string, unknown>;
  warnings: string[];
};
export function parseInstant(value: unknown, zone: string): string | null {
  if (typeof value !== "string") return null;
  // Date-only records and missing years remain unknown. ISO without seconds accepted, explicit time required.
  if (!/^\d{4}-\d\d-\d\d[T ]\d\d:\d\d/.test(value.trim())) return null;
  const d = DateTime.fromISO(value.trim().replace(" ", "T"), {
    zone,
    setZone: true,
  });
  if (!d.isValid) return null;
  // Reject non-existent local wall times (spring DST gap) instead of silently shifting them.
  if (
    !/(Z|[+-]\d\d:\d\d)$/.test(value) &&
    d.toFormat("yyyy-MM-dd'T'HH:mm") !==
      value.trim().replace(" ", "T").slice(0, 16)
  )
    return null;
  if (!/(Z|[+-]\d\d:\d\d)$/.test(value) && d.getPossibleOffsets().length > 1)
    return null;
  return d.toUTC().toISO();
}
const aliases: Record<string, string[]> = {
  title: ["title", "event", "event title", "活动", "名称", "课程"],
  start_at: ["start_at", "start", "开始", "开始时间"],
  end_at: ["end_at", "end", "结束", "结束时间"],
  deadline_at: ["deadline_at", "deadline", "截止", "截止时间"],
  location: ["location", "地点"],
  description: ["description", "描述"],
  preparation: ["preparation", "准备"],
  course: ["course", "课程名称"],
  source_url: ["source_url", "source", "url", "来源", "链接"],
  status: ["status", "状态"],
  category: ["category", "类别"],
  notes: ["notes", "备注"],
  recurrence_rule: ["recurrence_rule", "rrule"],
};
export function rowProposal(
  row: Record<string, unknown>,
  sourceType: string,
  zone = "Europe/London",
): Proposal {
  const normalized = Object.fromEntries(
    Object.entries(row).map(([k, v]) => [k.toLowerCase().trim(), v]),
  );
  const get = (key: string) =>
    aliases[key]
      ?.map((a) => normalized[a])
      .find((v) => v !== undefined && v !== null && v !== "");
  const warnings: string[] = [];
  const title = String(get("title") || "未命名记录").slice(0, 200);
  const rawStatus = String(get("status") || "");
  const statusMap: Record<string, string> = {
    已确认: "confirmed",
    确认: "confirmed",
    冲突: "conflict",
    待定: "planned",
    取消: "cancelled",
    已预约: "booked",
    已申请: "applied",
    待考虑: "considering",
    计划中: "planned",
    待核实: "waiting",
    已取消: "cancelled",
    已完成: "completed",
  };
  let status = statusMap[rawStatus] || rawStatus || "considering";
  if (
    ![
      "confirmed",
      "conflict",
      "booked",
      "applied",
      "planned",
      "considering",
      "waiting",
      "cancelled",
      "completed",
    ].includes(status)
  ) {
    status = "waiting";
    warnings.push("原状态不明确，请核实");
  }
  const data: Record<string, unknown> = {
    title,
    status,
    category: [
      "academic",
      "technical",
      "career",
      "social",
      "personal",
      "other",
    ].includes(String(get("category")))
      ? get("category")
      : "academic",
    timezone: zone,
  };
  for (const k of ["start_at", "end_at", "deadline_at"]) {
    const raw = get(k);
    data[k] = parseInstant(raw, zone);
    if (raw && !data[k])
      warnings.push(`${k}：日期 / 时间或时区不明确，保留原记录供审核`);
  }
  if (
    data.end_at &&
    (!data.start_at ||
      Date.parse(String(data.end_at)) <= Date.parse(String(data.start_at)))
  ) {
    data.end_at = null;
    warnings.push("结束时间无效，需核实");
  }
  for (const k of [
    "location",
    "description",
    "preparation",
    "course",
    "notes",
    "recurrence_rule",
  ])
    if (get(k))
      data[k] = String(get(k)).slice(
        0,
        k === "description" || k === "notes" ? 10000 : 1000,
      );
  if (data.recurrence_rule) {
    data.recurring = true;
    warnings.push("检测到重复规则：当前仅保存原始发生时间，不自动展开重复活动");
  }
  if (!data.start_at && !data.deadline_at)
    warnings.push("没有明确活动时间或截止时间");
  const sourceUrl = String(get("source_url") || "");
  if (sourceUrl && !/^https?:\/\//.test(sourceUrl))
    warnings.push("来源链接无效，保留为来源备注");
  return {
    payload: eventInput.parse(data),
    source: {
      source_type: sourceType,
      url: /^https?:\/\//.test(sourceUrl) ? sourceUrl : null,
      original_record: row,
      notes: "导入记录；尚未经来源复核",
    },
    warnings,
  };
}
export function deduplicate(
  p: Proposal,
  events: (CalendarEvent & { version: number })[],
): Proposal {
  const same = (a: unknown, b: unknown) =>
    (!a && !b) ||
    (!!a && !!b && Date.parse(String(a)) === Date.parse(String(b)));
  const matches = events.filter(
    (e) =>
      e.title.toLowerCase().trim() ===
        String(p.payload.title).toLowerCase().trim() &&
      same(e.start_at, p.payload.start_at) &&
      same(e.deadline_at, p.payload.deadline_at),
  );
  if (matches.length === 1)
    return {
      ...p,
      event_id: matches[0].id,
      expected_version: matches[0].version,
      warnings: [
        ...p.warnings,
        "检测到同名同时间记录：确认后更新，旧来源与历史保留",
      ],
    };
  if (matches.length > 1) p.warnings.push("多条潜在重复记录，请先人工核实");
  return p;
}
export function naturalProposal(
  text: string,
  events: (CalendarEvent & { version: number })[],
  now = DateTime.now().setZone("Europe/London"),
): Proposal {
  const lowered = text.toLowerCase();
  const matches = events.filter((e) => {
    const title = e.title.toLowerCase();
    const base = title.replace(/\bgroup\s+[a-z]\b/g, "").trim();
    const words = base.split(/\s+/);
    const aliases = [
      title,
      base,
      ...words.slice(0, -1).map((word, i) => `${word} ${words[i + 1]}`),
    ];
    return aliases.some(
      (alias) => alias.length >= 3 && lowered.includes(alias),
    );
  });
  let status: string | undefined;
  if (/取消/.test(text)) status = "cancelled";
  else if (/标记.{0,4}冲突|状态.{0,4}冲突/.test(text)) status = "conflict";
  else if (/预约成功|已经预约|已预约/.test(text)) status = "booked";
  else if (/已确认|确认参加/.test(text)) status = "confirmed";
  else if (/报名|申请|first choice|第一志愿|首选/.test(text))
    status = "applied";
  else if (/待考虑|考虑/.test(text)) status = "considering";
  const warnings: string[] = [];
  const source = {
    source_type: "conversation",
    notes: text,
    received_at: now.toUTC().toISO(),
  };
  let candidates = matches;
  const weekday = text.match(/(?:周|星期)([一二三四五六日天])/);
  if (weekday) {
    const day =
      "一二三四五六日".indexOf(weekday[1] === "天" ? "日" : weekday[1]) + 1;
    candidates = candidates.filter(
      (e) =>
        e.start_at &&
        DateTime.fromISO(e.start_at).setZone(now.zoneName!).weekday === day,
    );
  }
  const explicit = text.match(/(\d{4})[年/-](\d{1,2})[月/-](\d{1,2})日?/);
  const short = text.match(/(?<!\d)(\d{1,2})月(\d{1,2})日/);
  let date: string | null = null;
  if (explicit)
    date = DateTime.fromObject(
      { year: +explicit[1], month: +explicit[2], day: +explicit[3] },
      { zone: now.zoneName! },
    ).toISODate();
  else if (short) warnings.push("日期缺少年份；未自动推断年份");
  else if (/明天/.test(text)) date = now.plus({ days: 1 }).toISODate();
  if (date)
    candidates = candidates.filter(
      (e) =>
        e.start_at &&
        DateTime.fromISO(e.start_at).setZone(now.zoneName!).toISODate() ===
          date,
    );
  else if (short)
    candidates = candidates.filter(
      (e) =>
        e.start_at &&
        DateTime.fromISO(e.start_at).setZone(now.zoneName!).month ===
          +short[1] &&
        DateTime.fromISO(e.start_at).setZone(now.zoneName!).day === +short[2],
    );
  if (candidates.length === 1) {
    const e = candidates[0];
    const payload: Record<string, unknown> = {};
    if (status) payload.status = status;
    const end = text.match(/(\d{1,2}):(\d{2})\s*(?:下课|结束)/);
    if (end && e.start_at) {
      const d = DateTime.fromISO(e.start_at)
        .setZone(now.zoneName!)
        .set({ hour: +end[1], minute: +end[2], second: 0 });
      if (d.isValid && d > DateTime.fromISO(e.start_at))
        payload.end_at = d.toUTC().toISO();
      else warnings.push("结束时间无效，未应用");
    }
    if (!Object.keys(payload).length)
      warnings.push("无法可靠识别修改，请使用事件编辑器");
    return {
      event_id: e.id,
      expected_version: e.version,
      payload,
      source,
      warnings,
    };
  }
  warnings.push(
    candidates.length > 1
      ? "匹配多个活动，未自动修改任何记录"
      : "未唯一匹配现有活动；请核实标题与时间",
  );
  return {
    payload: eventInput.parse({
      title: text.slice(0, 200),
      status: status || "waiting",
      notes: text,
    }),
    source,
    warnings,
  };
}
