"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { browserDB, configured } from "@/lib/supabase";
import { loadKnowledge } from "@/lib/knowledge-client";
import {
  markdownFilename,
  neighborhood,
  nodeMarkdown,
  type KnowledgeNode,
  type KnowledgeEdge,
} from "@/lib/knowledge";
type Hit = {
  node_id: string;
  event_id: string;
  card_id: string | null;
  title: string;
  excerpt: string;
  kind: string;
  start_at: string | null;
};
const labels: Record<string, string> = {
  event: "日程",
  note: "便签",
  image: "图片",
  link: "链接",
  pdf: "PDF",
};
export default function SearchWorkspace() {
  const [query, setQuery] = useState(""),
    [hits, setHits] = useState<Hit[]>([]),
    [nodes, setNodes] = useState<KnowledgeNode[]>([]),
    [edges, setEdges] = useState<KnowledgeEdge[]>([]),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [user, setUser] = useState(false),
    [selected, setSelected] = useState(""),
    [searched, setSearched] = useState(false),
    [truncated, setTruncated] = useState(false);
  const seq = useRef(0);
  async function refresh() {
    const data = await loadKnowledge();
    setNodes(data.nodes);
    setEdges(data.edges);
    setTruncated(data.truncated);
    return data;
  }
  useEffect(() => {
    (async () => {
      if (!configured()) throw Error("尚未配置 Supabase。");
      const {
        data: { user },
      } = await browserDB().auth.getUser();
      if (!user) throw Error("请先返回日历登录。");
      setUser(true);
      await refresh();
    })().catch((e) => setMessage(e.message));
  }, []);
  async function search() {
    const current = ++seq.current;
    setBusy(true);
    setMessage("");
    try {
      const text = query.trim();
      if (!text) throw Error("请输入关键词。");
      const r = await browserDB().rpc("search_knowledge", {
        search_text: text,
      });
      if (r.error)
        throw Error("搜索失败，请稍后重试；若持续失败，请检查搜索迁移。");
      if (current === seq.current) {
        setHits(r.data || []);
        setSearched(true);
        await refresh();
      }
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "搜索失败。");
    } finally {
      if (current === seq.current) setBusy(false);
    }
  }
  const graph = useMemo(
    () => neighborhood(new Set(hits.map((h) => h.node_id)), nodes, edges),
    [hits, nodes, edges],
  );
  const displayed = graph.nodes.slice(0, 60);
  const positions = new Map(
    displayed.map((n, i) => {
      const angle = (i * 2 * Math.PI) / Math.max(1, displayed.length);
      return [
        n.id,
        { x: 450 + 330 * Math.cos(angle), y: 300 + 230 * Math.sin(angle) },
      ];
    }),
  );
  const href = (n: { eventId: string; cardId?: string }) =>
    `/events/${n.eventId}/board${n.cardId ? "#card-" + n.cardId : ""}`;
  async function connect(target: Hit) {
    const source = nodes.find((n) => n.id === selected);
    if (!source || selected === target.node_id) {
      setMessage("请选择两个不同节点。");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const r = await browserDB()
        .from("knowledge_links")
        .insert({
          from_event: source.eventId,
          from_card: source.cardId || null,
          to_event: target.event_id,
          to_card: target.card_id,
        });
      if (r.error) throw Error("关联未保存，请检查是否重复。");
      await refresh();
      setSelected("");
      setMessage("关联已保存，可在关系图和导出文件中查看。");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "保存失败。");
    } finally {
      setBusy(false);
    }
  }
  async function exportVault() {
    setBusy(true);
    setMessage("正在准备 Markdown 和附件…");
    try {
      const all = await refresh();
      if (all.truncated)
        throw Error(
          "资料量超过本次导出上限，请先缩小资料集；未生成不完整备份。",
        );
      const JSZip = (await import("jszip")).default;
      const zip = new JSZip();
      let failures = 0;
      let total = 0;
      for (const node of all.nodes) {
        let attachment: string | undefined;
        if (node.filePath) {
          const extension =
            node.filePath
              .split(".")
              .pop()
              ?.replace(/[^a-z0-9]/gi, "") || "bin";
          attachment = `attachments/${node.id.replace(":", "-")}.${extension}`;
          const file = await browserDB()
            .storage.from("event-board")
            .download(node.filePath);
          if (file.error || !file.data) {
            failures++;
            attachment = undefined;
          } else {
            total += file.data.size;
            if (total > 100 * 1024 * 1024)
              throw Error(
                "附件超过100 MB，本次导出已停止；请分别下载较大的附件。",
              );
            zip.file(attachment, file.data);
          }
        }
        zip.file(
          markdownFilename(node),
          nodeMarkdown(node, all.nodes, all.edges, attachment),
        );
      }
      const [ink, layout] = await Promise.all([
        browserDB()
          .from("board_highlights")
          .select("id,event_id,card_id,page,color,points")
          .limit(1000),
        browserDB()
          .from("event_board_cards")
          .select("id,event_id,x,y,display_width,pdf_page")
          .limit(1000),
      ]);
      if (ink.error || layout.error)
        throw Error("批注或布局无法读取，本次导出已停止。");
      if ((ink.data?.length || 0) >= 1000)
        throw Error("批注量超过本次导出上限，请分批备份；未生成不完整备份。");
      zip.file(
        "YING-board-layout-and-highlights.json",
        JSON.stringify(
          { version: 1, layout: layout.data, highlights: ink.data },
          null,
          2,
        ),
      );
      zip.file(
        "README.md",
        "# YING OS 私人资料导出\n\n解压后可作为 Obsidian vault 打开；每条日程和卡片是独立 Markdown 文件。关联使用稳定 ID 的双向链接。附件放在 attachments 文件夹。此文件不会自动同步回 YING OS。\n",
      );
      const blob = await zip.generateAsync({ type: "blob" });
      const object = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = object;
      a.download = "YING-OS-private-vault.zip";
      a.click();
      setTimeout(() => URL.revokeObjectURL(object), 10000);
      setMessage(
        failures
          ? `已导出，但 ${failures} 个附件读取失败；对应笔记已注明附件缺失，请单独检查。`
          : "已下载私人 Markdown 资料包；解压后可用 Obsidian 打开。",
      );
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "导出失败。");
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="knowledge-page">
      <Link href="/">← 返回日历</Link>
      <header className="knowledge-heading">
        <div>
          <p className="eyebrow">私人知识网络</p>
          <h1>搜索与关联</h1>
        </div>
        <button disabled={busy || !user} onClick={() => void exportVault()}>
          导出到 Obsidian / Markdown
        </button>
      </header>
      <p className="muted">
        搜索日程、便签、图片说明、链接及 PDF 文件名和阅读笔记。用 [[唯一标题]]
        引用其他资料，或在搜索结果中手动关联。
      </p>
      <form
        className="knowledge-search"
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <input
          type="search"
          aria-label="搜索所有日程与看板文字"
          placeholder="搜索课程、人物、想法或资料…"
          required
          maxLength={200}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          disabled={!user}
        />
        <button className="primary" disabled={busy || !user}>
          {busy ? "处理中…" : "搜索"}
        </button>
      </form>
      <p role="status" aria-live="polite">
        {message}
      </p>
      {truncated && (
        <p className="conflict">
          资料较多，关系图只载入部分节点；搜索仍由数据库执行，最多返回200项。
        </p>
      )}
      {selected && (
        <p className="notice">
          起点：{nodes.find((n) => n.id === selected)?.title}
          。可更换关键词搜索终点，再点「连接到这里」。
          <button onClick={() => setSelected("")}>取消</button>
        </p>
      )}
      <div className="knowledge-layout">
        <section>
          <h2>
            {searched
              ? `搜索结果 · ${hits.length}${hits.length === 200 ? "（已达上限）" : ""}`
              : "从一个关键词开始"}
          </h2>
          {searched && !hits.length && (
            <p className="muted">
              没有匹配结果。PDF 正文和图片中的文字暂不自动识别。
            </p>
          )}
          {hits.map((hit) => (
            <article className="panel knowledge-hit" key={hit.node_id}>
              <p className="eyebrow">{labels[hit.kind] || hit.kind}</p>
              <h3>
                <Link
                  href={href({
                    eventId: hit.event_id,
                    cardId: hit.card_id || undefined,
                  })}
                >
                  {hit.title}
                </Link>
              </h3>
              <p>{hit.excerpt}</p>
              <button disabled={busy} onClick={() => setSelected(hit.node_id)}>
                作为关联起点
              </button>
              {selected && selected !== hit.node_id && (
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() => void connect(hit)}
                >
                  连接到这里
                </button>
              )}
            </article>
          ))}
        </section>
        <section className="knowledge-graph">
          <h2>关联视图</h2>
          <p className="muted">
            显示命中节点及一层关联。绿色为日程，金色为资料。实线为所属 /
            手动连线，虚线为 [[引用]]。同名不明确的引用不会自动连线。
          </p>
          {!displayed.length ? (
            <p className="muted">搜索后在这里查看资料之间的联系。</p>
          ) : (
            <svg viewBox="0 0 900 600" role="img" aria-label="搜索结果关系图">
              {graph.edges.map((e) => {
                const a = positions.get(e.from),
                  b = positions.get(e.to);
                return a && b ? (
                  <line
                    key={e.id}
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                    strokeDasharray={e.kind === "wiki" ? "6 5" : undefined}
                  />
                ) : null;
              })}
              {displayed.map((n) => {
                const p = positions.get(n.id)!;
                return (
                  <a key={n.id} href={href(n)} aria-label={`打开${n.title}`}>
                    <title>{n.title}</title>
                    <circle
                      cx={p.x}
                      cy={p.y}
                      r={n.kind === "event" ? 11 : 7}
                      className={
                        n.kind === "event" ? "graph-event" : "graph-card"
                      }
                    />
                    <text x={p.x} y={p.y + 27} textAnchor="middle">
                      {n.title.slice(0, 16)}
                    </text>
                  </a>
                );
              })}
            </svg>
          )}
          {graph.nodes.length > 60 && <p>为保持清晰，图中仅显示前60个节点。</p>}
          <details>
            <summary>手动关联管理</summary>
            {edges
              .filter((e) => e.kind === "manual")
              .map((e) => (
                <p key={e.id}>
                  {nodes.find((n) => n.id === e.from)?.title || "资料"} →{" "}
                  {nodes.find((n) => n.id === e.to)?.title || "资料"}{" "}
                  <button
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      try {
                        const r = await browserDB()
                          .from("knowledge_links")
                          .delete()
                          .eq("id", e.id);
                        if (r.error) throw Error("移除失败。");
                        await refresh();
                      } catch {
                        setMessage("移除关联失败，请重试。");
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    移除
                  </button>
                </p>
              ))}
          </details>
        </section>
      </div>
    </main>
  );
}
