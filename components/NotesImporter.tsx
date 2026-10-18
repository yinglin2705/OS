"use client";
import { useEffect, useState, useRef } from "react";
import { browserDB } from "@/lib/supabase";
import { references } from "@/lib/knowledge";
import type { NotePayload, NoteProposal } from "@/lib/note-ingestion";
type Proposal = NoteProposal & { id: string; batch_id: string; state: string };
type Batch = {
  id: string;
  course: string;
  engine: string;
  state: string;
  source_label: string;
};
export default function NotesImporter({
  course,
  events,
  onSaved,
  onMessage,
}: {
  course: string;
  events: { id: string; title: string; start_at: string | null }[];
  onSaved: () => Promise<void>;
  onMessage: (s: string) => void;
}) {
  const [text, setText] = useState(""),
    [courseName, setCourse] = useState(course === "all" ? "未分类" : course),
    [useAI, setAI] = useState(false),
    [aiReady, setReady] = useState(false),
    [busy, setBusy] = useState(false);
  const [batches, setBatches] = useState<Batch[]>([]),
    [batch, setBatch] = useState<Batch | null>(null),
    [proposals, setProposals] = useState<Proposal[]>([]),
    [raw, setRaw] = useState("");
  const file = useRef<HTMLInputElement>(null),
    lock = useRef(false);
  async function load() {
    const r = await browserDB()
      .from("note_import_batches")
      .select("id,course,engine,state,source_label")
      .order("created_at", { ascending: false })
      .limit(30);
    if (r.error) throw Error("无法读取笔记导入记录。");
    setBatches(r.data || []);
    return r.data || [];
  }
  useEffect(() => {
    load().catch((e) => onMessage(e.message));
    fetch("/api/notes/ingest")
      .then((r) => r.json())
      .then((d) => setReady(d.aiConfigured === true))
      .catch(() => setReady(false));
  }, []);
  async function open(b: Batch) {
    setBatch(b);
    setRaw("");
    const p = await browserDB()
      .from("note_import_proposals")
      .select("*")
      .eq("batch_id", b.id)
      .order("created_at");
    if (p.error) {
      onMessage("提议无法读取");
      return;
    }
    setProposals(p.data || []);
  }
  async function run(body: FormData | Record<string, unknown>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    onMessage("正在整理课堂记录…");
    try {
      const r = await fetch("/api/notes/ingest", {
        method: "POST",
        headers:
          body instanceof FormData
            ? undefined
            : { "Content-Type": "application/json" },
        body: body instanceof FormData ? body : JSON.stringify(body),
      });
      const result = await r.json();
      if (!r.ok) throw Error(result.error || "整理失败");
      const data = await load();
      const b = data.find((b) => b.id === result.batchId);
      if (b) await open(b);
      onMessage(
        `${result.engine === "ai" ? "AI" : "规则"}整理完成，${result.count}篇待预览；尚未写入笔记。`,
      );
    } catch (e) {
      onMessage(e instanceof Error ? e.message : "网络请求失败。");
    } finally {
      lock.current = false;
      setBusy(false);
      if (file.current) file.current.value = "";
    }
  }
  function patch(id: string, changes: Partial<Proposal>) {
    setProposals((s) => s.map((p) => (p.id === id ? { ...p, ...changes } : p)));
  }
  function payload(id: string, key: keyof NotePayload, value: unknown) {
    setProposals((s) =>
      s.map((p) =>
        p.id === id ? { ...p, payload: { ...p.payload, [key]: value } } : p,
      ),
    );
  }
  async function confirm() {
    if (!batch || busy || lock.current) return;
    if (proposals.some((p) => p.action === "review")) {
      onMessage("请先处理标注为重复的笔记：选择更新、另存或跳过。");
      return;
    }
    if (
      !window.confirm(
        `确认导入这批${proposals.length}篇提议？将保留课程、原文和关联；跳过项不改动已有笔记。`,
      )
    )
      return;
    lock.current = true;
    setBusy(true);
    try {
      for (const p of proposals) {
        const r = await browserDB()
          .from("note_import_proposals")
          .update({
            payload: {
              ...p.payload,
              related_titles: references(p.payload.body),
            },
            action: p.action,
            target_note_id: p.target_note_id,
            expected_version: p.expected_version,
            warnings: p.warnings,
          })
          .eq("id", p.id)
          .eq("state", "pending");
        if (r.error) throw Error("预览修改未保存，请刷新核对后再确认。");
      }
      const r = await browserDB().rpc("confirm_note_batch", {
        target: batch.id,
      });
      if (r.error)
        throw Error(
          "确认失败，可能有笔记已变化或关联已删除；这批更改未写入，请重新检查预览。",
        );
      onMessage(`已保存${r.data}篇笔记；原文、版本与关联保留。`);
      await onSaved();
      const data = await load();
      const b = data.find((b) => b.id === batch.id);
      if (b) await open(b);
    } catch (e) {
      onMessage(e instanceof Error ? e.message : "确认失败。");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="panel notes-importer">
      <h2>课堂聊天 → 独立笔记</h2>
      <p className="muted">
        按课次整理知识点、步骤、问题和待办。原文保留，确认前不修改笔记或日程。无法直接读取其他ChatGPT聊天框。
      </p>
      <label>
        统一课程名称
        <input
          value={courseName}
          maxLength={200}
          onChange={(e) => setCourse(e.target.value)}
          disabled={busy}
          placeholder="例如 C4D"
        />
      </label>
      <label>
        整理方式
        <select
          value={useAI ? "ai" : "rules"}
          onChange={(e) => setAI(e.target.value === "ai")}
          disabled={busy}
        >
          <option value="rules">规则整理（无需模型密钥）</option>
          <option value="ai" disabled={!aiReady}>
            AI整理{aiReady ? "" : "（未配置）"}
          </option>
        </select>
      </label>
      {useAI && (
        <p className="notice">
          AI整理会将本次文本及相关课程日程候选发送至配置的OpenAI服务。结果标为待核实，不发送到GitHub。
        </p>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run({ text, course: courseName, useAI });
        }}
      >
        <textarea
          aria-label="课堂聊天原文"
          required
          maxLength={60000}
          rows={7}
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={busy}
          placeholder="可粘贴整段聊天。建议每课次以 # 2026-10-19 C4D 这样的标题分开；缺失日期会保留未知。"
        />
        <button className="primary" disabled={busy}>
          {busy ? "整理中…" : "整理并预览"}
        </button>
      </form>
      <label>
        或上传TXT / Markdown / ChatGPT JSON（≤4 MB）
        <input
          ref={file}
          type="file"
          accept=".txt,.md,.json"
          disabled={busy}
          onChange={(e) => {
            const selected = e.target.files?.[0];
            if (!selected) return;
            const form = new FormData();
            form.set("file", selected);
            form.set("course", courseName);
            form.set("useAI", String(useAI));
            void run(form);
          }}
        />
      </label>
      {batches.length > 0 && (
        <label>
          导入记录
          <select
            value={batch?.id || ""}
            disabled={busy}
            onChange={(e) => {
              const b = batches.find((b) => b.id === e.target.value);
              if (b) void open(b);
            }}
          >
            <option value="">选择记录</option>
            {batches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.course} · {b.source_label} ·{" "}
                {b.state === "accepted" ? "已确认" : "待确认"}
              </option>
            ))}
          </select>
        </label>
      )}
      {batch && (
        <>
          <div className="actions">
            <button
              disabled={busy}
              onClick={async () => {
                const r = await browserDB()
                  .from("note_import_batches")
                  .select("source_text")
                  .eq("id", batch.id)
                  .single();
                if (r.error) onMessage("原文读取失败");
                else setRaw(r.data.source_text);
              }}
            >
              查看完整原文
            </button>
            <button
              disabled={busy}
              onClick={async () => {
                if (
                  !window.confirm(
                    "删除此导入批次和提议？已导入的笔记与各篇原文来源会保留。",
                  )
                )
                  return;
                const r = await browserDB().rpc("delete_note_record", {
                  record_type: "batch",
                  target: batch.id,
                });
                if (r.error) {
                  onMessage("删除失败");
                  return;
                }
                setBatch(null);
                setProposals([]);
                setRaw("");
                await load();
              }}
            >
              删除导入记录
            </button>
          </div>
          {raw && (
            <details open>
              <summary>完整原文</summary>
              <pre className="notes-source">{raw}</pre>
            </details>
          )}
          <h3>
            预览 · {proposals.length}篇 ·{" "}
            {batch.engine === "ai" ? "AI整理，待核实" : "规则整理"}
          </h3>
          {proposals.map((p) => (
            <article className="notes-proposal" key={p.id}>
              <label>
                笔记标题
                <input
                  value={p.payload.title}
                  disabled={busy || batch.state === "accepted"}
                  maxLength={200}
                  onChange={(e) => payload(p.id, "title", e.target.value)}
                />
              </label>
              <label>
                课次日期（可留空）
                <input
                  type="date"
                  value={p.payload.lesson_date || ""}
                  disabled={busy || batch.state === "accepted"}
                  onChange={(e) =>
                    payload(p.id, "lesson_date", e.target.value || null)
                  }
                />
              </label>
              {p.warnings.map((w, i) => (
                <p className="muted" key={i}>
                  · {w}
                </p>
              ))}
              <label>
                处理方式
                <select
                  value={p.action}
                  disabled={busy || batch.state === "accepted"}
                  onChange={(e) =>
                    patch(p.id, {
                      action: e.target.value as Proposal["action"],
                    })
                  }
                >
                  <option value="review">待检查重复</option>
                  <option value="create">另存为独立笔记</option>
                  <option value="update" disabled={!p.target_note_id}>
                    更新匹配笔记
                  </option>
                  <option value="skip">跳过</option>
                </select>
              </label>
              <label>
                整理正文
                <textarea
                  value={p.payload.body}
                  rows={9}
                  disabled={busy || batch.state === "accepted"}
                  maxLength={100000}
                  onChange={(e) => payload(p.id, "body", e.target.value)}
                />
              </label>
              <p className="muted">
                课程：{p.payload.course} · 建议关联日程
                {p.payload.event_ids.length}项 · 笔记引用
                {p.payload.related_titles.length}项
              </p>
              {p.payload.event_ids.map((id) => (
                <p key={id}>
                  建议关联：
                  {events.find((e) => e.id === id)?.title ||
                    "已不在当前列表的日程"}{" "}
                  ·{" "}
                  {events.find((e) => e.id === id)?.start_at?.slice(0, 10) ||
                    "日期未知"}{" "}
                  <button
                    disabled={busy || batch.state === "accepted"}
                    onClick={() =>
                      payload(
                        p.id,
                        "event_ids",
                        p.payload.event_ids.filter((value) => value !== id),
                      )
                    }
                  >
                    移除此关联
                  </button>
                </p>
              ))}
              <p className="muted">
                笔记引用：
                {references(p.payload.body)
                  .map((t) => `[[${t}]]`)
                  .join("、") || "暂无"}
                。编辑正文中的引用即可调整连接。
              </p>
              {p.payload.event_ids.length > 0 && (
                <button
                  disabled={busy || batch.state === "accepted"}
                  onClick={() => payload(p.id, "event_ids", [])}
                >
                  不建立这篇的日程关联
                </button>
              )}
              <details>
                <summary>该篇原文来源</summary>
                <pre className="notes-source">{p.payload.source_excerpt}</pre>
              </details>
            </article>
          ))}
          {batch.state === "pending" && (
            <button
              className="primary"
              disabled={busy || !proposals.length}
              onClick={() => void confirm()}
            >
              一键确认导入（{proposals.length}篇）
            </button>
          )}
        </>
      )}
    </section>
  );
}
