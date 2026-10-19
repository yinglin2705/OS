import { NextResponse } from "next/server";
import { serverDB, sameOrigin } from "@/lib/server";
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
  const session = await serverDB();
  const {
    data: { user },
  } = await session.auth.getUser();
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });
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
    const records = proposals.map((p) => ({
      ...p,
      payload: eventInput.innerType().partial().parse(p.payload),
    }));
    const { data, error } = await session.rpc("ingest_calendar_records", {
      records,
      batch_source_type: sourceType,
      batch_filename: filename || null,
    });
    if (error)
      throw Error(
        "没有写入任何日程：请检查重复修改、记录字段或活动版本；刷新后再试。",
      );
    return NextResponse.json({
      count: records.length,
      event_ids: data,
      message: `已将${records.length}条记录直接写入日历，来源与历史保留。`,
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
