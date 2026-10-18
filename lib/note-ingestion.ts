import { z } from "zod";
import { DateTime } from "luxon";
import { createHash } from "node:crypto";
import { references } from "./knowledge";
export const notePayload = z
  .object({
    title: z.string().trim().min(1).max(200),
    course: z.string().trim().min(1).max(200),
    lesson_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable(),
    body: z.string().max(100000),
    tags: z.array(z.string().max(50)).max(20),
    event_ids: z.array(z.string().uuid()).max(20),
    related_titles: z.array(z.string().max(200)).max(30),
    source_excerpt: z.string().min(1).max(60000),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type NotePayload = z.infer<typeof notePayload>;
export type ExistingNote = {
  id: string;
  title: string;
  course: string;
  lesson_date: string | null;
  version: number;
  source_fingerprint: string | null;
};
export type NoteEvent = {
  id: string;
  title: string;
  course?: string | null;
  start_at?: string | null;
};
export type NoteProposal = {
  payload: NotePayload;
  action: "create" | "update" | "skip" | "review";
  target_note_id: string | null;
  expected_version: number | null;
  warnings: string[];
};
export const normalizeCourse = (s: string) =>
  s.trim().replace(/\s+/g, " ") || "未分类";
export const fingerprint = (s: string) =>
  createHash("sha256")
    .update(s.normalize("NFKC").replace(/\s+/g, " ").trim())
    .digest("hex");
function dateIn(text: string) {
  const m = text.match(/\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/);
  if (!m) return null;
  const d = `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  return DateTime.fromISO(d).isValid ? d : null;
}
export function chatText(bytes: Buffer, filename: string) {
  if (!filename.toLowerCase().endsWith(".json")) {
    if (!/\.(md|txt)$/i.test(filename))
      throw Error("笔记导入支持 TXT、Markdown 或 ChatGPT JSON。");
    return bytes.toString("utf8").replace(/^\uFEFF/, "");
  }
  const value = JSON.parse(bytes.toString("utf8"));
  const chats = Array.isArray(value) ? value : [value];
  const result: string[] = [];
  for (const chat of chats) {
    if (!chat || typeof chat !== "object" || !chat.mapping)
      throw Error("不是可识别的 ChatGPT 对话导出格式。");
    const map = chat.mapping as Record<
      string,
      {
        parent?: string;
        message?: {
          author?: { role?: string };
          content?: { parts?: unknown[] };
        };
      }
    >;
    let ids = Object.keys(map);
    if (chat.current_node) {
      const branch: string[] = [];
      const seen = new Set<string>();
      let current = String(chat.current_node);
      while (map[current] && !seen.has(current)) {
        seen.add(current);
        branch.push(current);
        current = map[current].parent || "";
      }
      ids = branch.reverse();
    }
    result.push(`对话：${String(chat.title || "未命名对话")}`);
    for (const id of ids) {
      const m = map[id]?.message;
      if (!m || !["user", "assistant"].includes(m.author?.role || "")) continue;
      const text = (m.content?.parts || [])
        .filter((p) => typeof p === "string")
        .join("\n");
      if (text)
        result.push(
          `【${m.author?.role === "assistant" ? "AI 回答：未经核实" : "用户原文"}】\n${text}`,
        );
    }
  }
  return result.join("\n\n");
}
export function splitLessons(text: string) {
  const lines = text.replace(/\r\n/g, "\n").split("\n"),
    chunks: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    const heading =
      /^\s*(?:#{1,3}\s+|(?:日期|课次)[:：]\s*|第.{1,8}[课讲]|Session\s+\d)/i.test(
        line,
      ) || /^\s*20\d{2}[-/]\d{1,2}[-/]\d{1,2}(?:\s|$)/.test(line);
    if (
      heading &&
      (dateIn(line) ||
        /^\s*(?:#{1,3}\s*)?(?:第.{1,8}[课讲]|Session\s+\d)/i.test(line)) &&
      current.some((s) => s.trim())
    ) {
      chunks.push(current.join("\n").trim());
      current = [];
    }
    current.push(line);
  }
  if (current.some((s) => s.trim())) chunks.push(current.join("\n").trim());
  if (
    chunks.length > 1 &&
    /^对话：/.test(chunks[0]) &&
    chunks[0].split("\n").length < 4
  )
    chunks.splice(0, 2, chunks[0] + "\n\n" + chunks[1]);
  if (chunks.length > 40) throw Error("课次过多，请分批导入，每次最多40篇。");
  return chunks;
}
export function ruleNotes(text: string, courseName: string): NotePayload[] {
  const course = normalizeCourse(courseName);
  return splitLessons(text).map((source, index) => {
    const date = dateIn(source.split("\n").slice(0, 3).join("\n"));
    const header = source.split("\n").slice(0, 3).join("\n");
    const inferred =
      header.match(/(?:课程|Course)[:：]\s*([^\n]{1,200})/i)?.[1] ||
      ["C4D", "Coding", "Contextual Theory", "Stage Crew"].find((name) =>
        header.toLowerCase().includes(name.toLowerCase()),
      );
    const noteCourse =
      course === "未分类" ? inferred?.trim() || course : course;
    const lines = source
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    const buckets: { [key: string]: string[] } = {
      points: [],
      steps: [],
      questions: [],
      todos: [],
    };
    let section = "points";
    for (const original of lines) {
      const line = original.replace(/^#{1,6}\s*/, "");
      if (/^(知识点|概念|key points)\s*[:：]?$/i.test(line)) {
        section = "points";
        continue;
      }
      if (/^(操作步骤|步骤|steps)\s*[:：]?$/i.test(line)) {
        section = "steps";
        continue;
      }
      if (/^(问题|疑问|questions)\s*[:：]?$/i.test(line)) {
        section = "questions";
        continue;
      }
      if (/^(待办|下一步|todo)\s*[:：]?$/i.test(line)) {
        section = "todos";
        continue;
      }
      const target = /\?|？/.test(line)
        ? "questions"
        : /^(?:[-*]\s*\[ \]|TODO\b|待办[:：])/i.test(line)
          ? "todos"
          : /^\d+[.)、]\s*/.test(line)
            ? "steps"
            : section;
      buckets[target].push(line);
    }
    const title = `${noteCourse} · ${date || `未标注日期 · 第${index + 1}份`}`;
    const sectionBody = Object.entries({
      points: "知识点（待核实）",
      steps: "操作步骤",
      questions: "问题",
      todos: "待办",
    })
      .map(
        ([key, label]) =>
          `## ${label}\n\n${buckets[key].length ? buckets[key].map((s) => "- " + s.replace(/^[-*]\s*/, "")).join("\n") : "尚未明确提供。"}`,
      )
      .join("\n\n");
    return notePayload.parse({
      title,
      course: noteCourse,
      lesson_date: date,
      body: `> 规则整理；聊天中的 AI 陈述尚未经来源核实。\n\n${sectionBody}`,
      tags: [noteCourse],
      event_ids: [],
      related_titles: references(source),
      source_excerpt: source,
      fingerprint: fingerprint(noteCourse + "\n" + source),
    });
  });
}
export function prepareNoteProposals(
  payloads: NotePayload[],
  source: string,
  existing: ExistingNote[],
  events: NoteEvent[],
): NoteProposal[] {
  const result: NoteProposal[] = [];
  const seen = new Set<string>();
  for (const raw of payloads) {
    const p = notePayload.parse(raw);
    const warnings = [
      "整理结果与 AI 回答均待你核实；确认仅保存笔记，不证明知识点已验证。",
    ];
    const collapsed = (s: string) => s.replace(/\s+/g, " ").trim();
    if (!collapsed(source).includes(collapsed(p.source_excerpt)))
      throw Error("整理结果的来源引用与原文不匹配，未保存提议。");
    p.fingerprint = fingerprint(p.course + "\n" + p.source_excerpt);
    if (
      p.lesson_date &&
      (!DateTime.fromISO(p.lesson_date).isValid ||
        dateIn(p.source_excerpt) !== p.lesson_date)
    ) {
      p.lesson_date = null;
      warnings.push("课次日期缺少可验证的原文依据，已保留为未知。");
    }
    if (!p.lesson_date) warnings.push("日期未知；不会补成今天或午夜。");
    const allowed = new Set(events.map((e) => e.id));
    p.event_ids = p.event_ids.filter((id) => allowed.has(id));
    if (!p.event_ids.length && p.lesson_date) {
      const course = p.course.toLowerCase();
      p.event_ids = events
        .filter(
          (e) =>
            (e.title + " " + (e.course || "")).toLowerCase().includes(course) &&
            e.start_at &&
            DateTime.fromISO(e.start_at)
              .setZone("Europe/London")
              .toISODate() === p.lesson_date,
        )
        .map((e) => e.id);
      if (p.event_ids.length)
        warnings.push("按课程和日期建议关联日程；请在预览核实。");
    }
    const exact = existing.find((n) => n.source_fingerprint === p.fingerprint);
    const possible = existing.filter(
      (n) =>
        n.course.toLowerCase() === p.course.toLowerCase() &&
        n.title === p.title &&
        n.lesson_date === p.lesson_date,
    );
    // Suggestions are visible in the editable preview; course continuity is
    // evidence for a proposed connection, never a claim of semantic identity.
    const candidates = existing
      .filter(
        (n) =>
          n.course.toLowerCase() === p.course.toLowerCase() &&
          n.id !== exact?.id &&
          n.id !== possible[0]?.id &&
          (p.source_excerpt.includes(n.title) ||
            (p.lesson_date && n.lesson_date && n.lesson_date < p.lesson_date)),
      )
      .sort((a, b) => (b.lesson_date || "").localeCompare(a.lesson_date || ""));
    const suggested = candidates
      .slice(0, 2)
      .map((n) => n.title)
      .filter(
        (title) =>
          existing.filter((n) => n.title.toLowerCase() === title.toLowerCase())
            .length === 1 && !references(p.body).includes(title),
      );
    if (suggested.length) {
      p.body +=
        "\n\n## 建议关联笔记（可在预览删除）\n\n" +
        suggested.map((title) => `- [[${title}]]`).join("\n");
      p.related_titles = [
        ...new Set([...p.related_titles, ...suggested]),
      ].slice(0, 30);
      warnings.push(
        "按原文提及或同课程较早课次建议笔记关联；不是已核实的知识关系，可编辑删除。",
      );
    }
    const duplicateInFile = seen.has(p.fingerprint);
    seen.add(p.fingerprint);
    const target = exact || (possible.length === 1 ? possible[0] : undefined);
    const action =
      exact || duplicateInFile ? "skip" : possible.length ? "review" : "create";
    if (action === "skip")
      warnings.push("相同原文已存在或在本次文件中重复，默认跳过。");
    if (action === "review")
      warnings.push(
        "存在同名同课次笔记：请选择更新、另存或跳过，全部确认前必须处理。",
      );
    result.push({
      payload: p,
      action,
      target_note_id: target?.id || null,
      expected_version: target?.version || null,
      warnings,
    });
  }
  return result;
}
