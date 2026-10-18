import { NextResponse } from "next/server";
import { serverDB, adminDB, sameOrigin } from "@/lib/server";
import { fileRecords, MAX_BYTES } from "@/lib/file-import";
import { DateTime } from "luxon";
import {
  deduplicate,
  eventInput,
  naturalProposal,
  rowProposal,
  type Proposal,
} from "@/lib/ingestion";
export const runtime = "nodejs";
export async function POST(req: Request) {
  if (!sameOrigin(req))
    return NextResponse.json({ error: "来源验证失败" }, { status: 403 });
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY)
    return NextResponse.json(
      { error: "Supabase 服务端尚未配置" },
      { status: 503 },
    );
  const session = await serverDB();
  const {
    data: { user },
  } = await session.auth.getUser();
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const admin = adminDB();
  const { count } = await admin
    .from("ingestion_batches")
    .select("*", { count: "exact", head: true })
    .eq("user_id", user.id)
    .gt("created_at", new Date(Date.now() - 60000).toISOString());
  if ((count || 0) >= 10)
    return NextResponse.json(
      { error: "导入请求过多，请稍后重试" },
      { status: 429 },
    );
  const [{ data: events, error: eventError }, { data: settings }] =
    await Promise.all([
      session.from("events").select("*").is("deleted_at", null),
      session.from("users").select("timezone").eq("id", user.id).single(),
    ]);
  if (eventError)
    return NextResponse.json({ error: "无法读取现有记录" }, { status: 500 });
  const zone = settings?.timezone || "Europe/London";
  let proposals: Proposal[] = [];
  let sourceType = "manual",
    filename: string | undefined;
  try {
    if (Number(req.headers.get("content-length")) > MAX_BYTES + 65536)
      return NextResponse.json({ error: "文件上限为 4 MB" }, { status: 413 });
    // Bound chunked requests too, before parsing multipart or JSON.
    const reader = req.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader)
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.length;
        if (size > MAX_BYTES + 65536) {
          await reader.cancel();
          return NextResponse.json(
            { error: "请求上限为 4 MB" },
            { status: 413 },
          );
        }
        chunks.push(next.value);
      }
    const bounded = new Request(req.url, {
      method: "POST",
      headers: req.headers,
      body: Buffer.concat(chunks),
    });

    if (req.headers.get("content-type")?.includes("multipart/form-data")) {
      const form = await bounded.formData();
      const file = form.get("file");
      if (!(file instanceof File)) throw new Error("请选择文件");
      if (file.size > MAX_BYTES) throw new Error("文件上限为 4 MB");
      filename = file.name;
      const imported = await fileRecords(
        Buffer.from(await file.arrayBuffer()),
        filename,
      );
      sourceType = imported.sourceType;
      const rows = imported.rows;
      for (const historical of imported.messages) {
        const reference = historical.createdAt
          ? DateTime.fromSeconds(historical.createdAt).setZone(zone)
          : DateTime.now().setZone(zone);
        const proposal = naturalProposal(historical.text, [], reference);
        proposal.source = {
          ...proposal.source,
          source_type: "chatgpt_export",
          original_record: historical,
        };
        proposal.warnings.push(
          "历史对话不会自动匹配当前预约；请核实日期、年份、状态与已存在活动",
        );
        proposals.push(proposal);
      }
      proposals.push(
        ...rows.map((row) =>
          deduplicate(rowProposal(row, sourceType, zone), events || []),
        ),
      );
    } else {
      const body = await bounded.json();
      if (body.event) {
        const event = eventInput.parse(body.event);
        let target;
        if (body.event_id) {
          target = (events || []).find((e) => e.id === body.event_id);
          if (!target) throw new Error("活动不存在");
        }
        proposals = [
          {
            event_id: target?.id,
            expected_version: target?.version,
            payload: event,
            source: {
              source_type: "manual",
              url: body.source_url ? new URL(body.source_url).toString() : null,
              notes: body.source_notes || "用户编辑",
            },
            warnings: [],
          },
        ];
        if (
          proposals[0].source.url &&
          !/^https?:\/\//.test(String(proposals[0].source.url))
        )
          throw new Error("只支持 HTTP(S) 来源链接");
      } else if (
        typeof body.text === "string" &&
        body.text.trim() &&
        body.text.length <= 20000
      ) {
        sourceType = "conversation";
        proposals = [
          naturalProposal(
            body.text,
            events || [],
            DateTime.now().setZone(zone),
          ),
        ];
      } else throw new Error("请输入消息或事件");
    }
    if (!proposals.length) throw new Error("没有可导入的记录");
    const { data: batch, error: bError } = await admin
      .from("ingestion_batches")
      .insert({ user_id: user.id, source_type: sourceType, filename })
      .select("id")
      .single();
    if (bError) throw new Error("无法保存导入批次");
    const { error } = await admin
      .from("change_proposals")
      .insert(
        proposals.map((p) => ({ ...p, user_id: user.id, batch_id: batch.id })),
      );
    if (error) throw new Error("无法保存提议");
    return NextResponse.json({
      count: proposals.length,
      message: "已加入 AI 收件箱，确认前不会修改日历",
    });
  } catch (e) {
    return NextResponse.json(
      {
        error:
          e instanceof Error && !e.message.includes("[")
            ? e.message
            : "记录格式无效，请检查字段与日期",
      },
      { status: 400 },
    );
  }
}
