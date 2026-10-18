import { NextResponse } from "next/server";
import { serverDB, sameOrigin } from "@/lib/server";
import {
  chatText,
  ruleNotes,
  prepareNoteProposals,
  fingerprint,
  normalizeCourse,
} from "@/lib/note-ingestion";
import { aiNotes } from "@/lib/note-ai";
export const runtime = "nodejs";
export const maxDuration = 60;
export async function GET() {
  const {
    data: { user },
  } = await (await serverDB()).auth.getUser();
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  return NextResponse.json({ aiConfigured: !!process.env.OPENAI_API_KEY });
}
export async function POST(req: Request) {
  if (!sameOrigin(req))
    return NextResponse.json({ error: "来源验证失败" }, { status: 403 });
  const db = await serverDB();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  try {
    const reader = req.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader)
      while (true) {
        const r = await reader.read();
        if (r.done) break;
        size += r.value.length;
        if (size > 4 * 1024 * 1024 + 65536) {
          await reader.cancel();
          return NextResponse.json({ error: "文件上限4 MB" }, { status: 413 });
        }
        chunks.push(r.value);
      }
    const bounded = new Request(req.url, {
      method: "POST",
      headers: req.headers,
      body: Buffer.concat(chunks),
    });
    let text = "",
      course = "未分类",
      sourceLabel = "用户粘贴课堂记录",
      useAI = false;
    if (req.headers.get("content-type")?.includes("multipart/form-data")) {
      const f = await bounded.formData(),
        file = f.get("file");
      if (!(file instanceof File))
        throw Error("请选择聊天导出或TXT/Markdown文件。");
      text = chatText(Buffer.from(await file.arrayBuffer()), file.name);
      sourceLabel = file.name.slice(0, 255);
      course = String(f.get("course") || "未分类");
      useAI = f.get("useAI") === "true";
    } else {
      const b = await bounded.json();
      if (typeof b.text !== "string") throw Error("请提供课堂记录。");
      text = b.text;
      course = String(b.course || "未分类");
      useAI = b.useAI === true;
    }
    if (!text.trim() || text.length > 60000)
      throw Error("每次请提供1–60000字的课堂记录；较长聊天请按课次分批导入。");
    course = normalizeCourse(course);
    if (course.length > 200) throw Error("课程名称过长。");
    const [{ count, error: rateError }, notes, events] = await Promise.all([
      db
        .from("note_import_batches")
        .select("id", { count: "exact", head: true })
        .gt("created_at", new Date(Date.now() - 60000).toISOString()),
      db
        .from("notes")
        .select("id,title,course,lesson_date,version,source_fingerprint")
        .is("deleted_at", null)
        .limit(1000),
      db
        .from("events")
        .select("id,title,course,start_at")
        .is("deleted_at", null)
        .limit(1000),
    ]);
    if (rateError || notes.error || events.error)
      throw Error("笔记数据库尚未就绪，请稍后重试。");
    if ((notes.data?.length || 0) >= 1000 || (events.data?.length || 0) >= 1000)
      throw Error(
        "资料超过当前自动匹配上限，请先按课程缩小记录范围或联系管理员处理。",
      );
    if ((count || 0) >= 5)
      return NextResponse.json(
        { error: "整理请求过多，请一分钟后重试。" },
        { status: 429 },
      );
    const candidates = (events.data || [])
      .filter(
        (e) =>
          course === "未分类" ||
          (e.title + " " + (e.course || ""))
            .toLowerCase()
            .includes(course.toLowerCase()),
      )
      .slice(0, 100);
    const payloads = useAI
      ? await aiNotes(text, course, candidates)
      : ruleNotes(text, course);
    if (!payloads.length) throw Error("没有可整理的内容。");
    const proposals = prepareNoteProposals(
      payloads,
      text,
      notes.data || [],
      events.data || [],
    );
    const { data: batch, error } = await db
      .from("note_import_batches")
      .insert({
        user_id: user.id,
        course,
        source_text: text,
        source_label: sourceLabel,
        engine: useAI ? "ai" : "rules",
        source_hash: fingerprint(course + "\n" + text),
      })
      .select("id")
      .single();
    if (error || !batch) throw Error("无法保存预览批次。");
    const saved = await db
      .from("note_import_proposals")
      .insert(
        proposals.map((p) => ({ ...p, user_id: user.id, batch_id: batch.id })),
      );
    if (saved.error) {
      await db.rpc("delete_note_record", {
        record_type: "batch",
        target: batch.id,
      });
      throw Error("无法保存提议，未修改任何笔记。");
    }
    return NextResponse.json({
      batchId: batch.id,
      count: proposals.length,
      engine: useAI ? "ai" : "rules",
      message: "已生成预览，确认后才写入独立笔记。",
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "";
    const safe =
      message &&
      message.length < 250 &&
      !message.includes("{") &&
      !message.includes("[")
        ? message
        : "整理失败或结果格式无效，未修改笔记。";
    return NextResponse.json({ error: safe }, { status: 400 });
  }
}
