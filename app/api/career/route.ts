import { NextResponse } from "next/server";
import { serverDB, sameOrigin } from "@/lib/server";
import {
  analyseJD,
  matchJob,
  profileInput,
  jobInput,
  policyInput,
} from "@/lib/career/engine";
import { z } from "zod";
export const runtime = "nodejs";
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
    let size = 0;
    const chunks: Uint8Array[] = [];
    if (reader)
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.length;
        if (size > 400000) {
          await reader.cancel();
          return NextResponse.json({ error: "内容过长" }, { status: 413 });
        }
        chunks.push(item.value);
      }
    const text = Buffer.concat(chunks).toString("utf8");
    if (text.length > 120000)
      return NextResponse.json({ error: "内容过长" }, { status: 413 });
    const b = JSON.parse(text);
    let result;
    if (b.action === "claim") {
      const input = profileInput.parse(b.data);
      result = b.id
        ? await db
            .from("career_claims")
            .update(input)
            .eq("id", z.string().uuid().parse(b.id))
            .select()
            .single()
        : await db.from("career_claims").insert(input).select().single();
    } else if (b.action === "job") {
      const input = jobInput.parse(b.data);
      const source = new URL(input.source_url);
      source.hash = "";
      for (const key of [...source.searchParams.keys()])
        if (/^utm_/i.test(key)) source.searchParams.delete(key);
      input.source_url = source.toString();
      const data = { ...input, analysis: analyseJD(input.raw_jd) };
      result = b.id
        ? await db
            .from("career_opportunities")
            .update(data)
            .eq("id", z.string().uuid().parse(b.id))
            .select()
            .single()
        : await db.from("career_opportunities").insert(data).select().single();
    } else if (b.action === "analyse") {
      const id = z.string().uuid().parse(b.id);
      const [job, claims] = await Promise.all([
        db.from("career_opportunities").select("*").eq("id", id).single(),
        db.from("career_claims").select("*").limit(501),
      ]);
      if (job.error || !job.data || claims.error)
        throw Error("无法读取本人职业资料。");
      if ((claims.data?.length || 0) > 500)
        throw Error("资料超过单次分析上限，请先整理。");
      const analysis = analyseJD(job.data.raw_jd);
      const match = matchJob(analysis, claims.data || []);
      return NextResponse.json({ analysis, match });
    } else if (b.action === "policy") {
      const p = policyInput.parse(b.data);
      result = await db
        .from("career_opportunities")
        .update({
          policy_decision: p.decision,
          policy_url: p.source_url,
          policy_quote: p.quote,
        })
        .eq("id", z.string().uuid().parse(b.id))
        .select()
        .single();
    } else if (b.action === "draft") {
      const p = z
        .object({
          id: z.string().uuid(),
          kind: z.enum(["cv", "cover_letter", "personal_statement"]),
          claim_ids: z.array(z.string().uuid()).min(1).max(50),
          approved: z.literal(true),
        })
        .parse(b);
      result = await db.rpc("career_create_draft", {
        target: p.id,
        document_kind: p.kind,
        claim_ids: p.claim_ids,
      });
    } else if (b.action === "status") {
      const status = z
        .enum([
          "saved",
          "shortlisted",
          "drafting",
          "ready",
          "applied",
          "interview",
          "offer",
          "rejected",
          "withdrawn",
          "archived",
        ])
        .parse(b.status);
      result = await db
        .from("career_opportunities")
        .update({
          status,
          application_notes: z
            .string()
            .max(20000)
            .parse(b.notes || ""),
        })
        .eq("id", z.string().uuid().parse(b.id))
        .select()
        .single();
    } else if (b.action === "source") {
      const p = z
        .object({
          label: z.string().trim().min(1).max(200),
          board_token: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
          keywords: z.array(z.string().trim().min(2).max(80)).min(1).max(20),
          terms_url: z
            .string()
            .url()
            .max(2000)
            .refine((s) => s.startsWith("https://")),
          terms_note: z.string().trim().min(10).max(4000),
          enabled: z.boolean(),
          approved: z.literal(true),
        })
        .parse(b.data);
      const { approved, ...data } = p;
      void approved;
      result = b.id
        ? await db
            .from("career_sources")
            .update(data)
            .eq("id", z.string().uuid().parse(b.id))
            .select()
            .single()
        : await db.from("career_sources").insert(data).select().single();
    } else if (b.action === "delete") {
      const table = z
        .enum([
          "career_claims",
          "career_sources",
          "career_opportunities",
          "career_documents",
          "career_application_history",
          "career_discovery_runs",
        ])
        .parse(b.table);
      result = await db
        .from(table)
        .delete()
        .eq("id", z.string().uuid().parse(b.id))
        .select("id")
        .single();
    } else return NextResponse.json({ error: "未知操作" }, { status: 400 });
    if (result.error)
      return NextResponse.json(
        {
          error:
            b.action === "draft"
              ? "无法生成：请核实雇主AI政策和全部选中证据；未生成材料。"
              : "保存失败：请检查重复来源、资料、权限或数据库迁移。",
        },
        { status: 400 },
      );
    return NextResponse.json({ data: result.data });
  } catch (e) {
    return NextResponse.json(
      {
        error:
          e instanceof z.ZodError
            ? "请检查必填字段、链接和原文长度。"
            : e instanceof SyntaxError
              ? "无效请求。"
              : e instanceof Error
                ? e.message
                : "操作失败。",
      },
      { status: 400 },
    );
  }
}
