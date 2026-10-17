"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { browserDB, configured } from "@/lib/supabase";
type Card = {
  id: string;
  kind: "note" | "link" | "image";
  title: string;
  body: string;
  url: string | null;
  image_path: string | null;
  x: number;
  y: number;
  signedURL?: string;
};
type Edge = { id: string; from_card: string; to_card: string };
export default function EventBoard({ eventId }: { eventId: string }) {
  const [userId, setUserId] = useState(""),
    [title, setTitle] = useState("事件看板"),
    [cards, setCards] = useState<Card[]>([]),
    [edges, setEdges] = useState<Edge[]>([]);
  const [message, setMessage] = useState("正在读取…"),
    [busy, setBusy] = useState(false),
    [kind, setKind] = useState<Card["kind"]>("note");
  const [newTitle, setNewTitle] = useState(""),
    [body, setBody] = useState(""),
    [url, setURL] = useState(""),
    [file, setFile] = useState<File | null>(null);
  const [from, setFrom] = useState(""),
    [to, setTo] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const drag = useRef<{
    id: string;
    pointer: number;
    startX: number;
    startY: number;
    x: number;
    y: number;
  } | null>(null);
  const lock = useRef(false);
  async function reload() {
    const db = browserDB();
    const [c, e] = await Promise.all([
      db
        .from("event_board_cards")
        .select("*")
        .eq("event_id", eventId)
        .order("created_at"),
      db
        .from("event_board_edges")
        .select("id,from_card,to_card")
        .eq("event_id", eventId),
    ]);
    if (c.error || e.error)
      throw Error("看板无法读取；请确认数据库看板迁移已部署。");
    const data = await Promise.all(
      (c.data as Card[]).map(async (card) => {
        if (!card.image_path) return card;
        const signed = await db.storage
          .from("event-board")
          .createSignedUrl(card.image_path, 3600);
        return { ...card, signedURL: signed.data?.signedUrl };
      }),
    );
    setCards(data);
    setEdges(e.data || []);
  }
  useEffect(() => {
    let active = true;
    (async () => {
      if (!configured()) throw Error("尚未配置 Supabase。");
      const db = browserDB();
      const {
        data: { user },
      } = await db.auth.getUser();
      if (!user) throw Error("请先返回日历登录，再打开看板。");
      const { data, error } = await db
        .from("events")
        .select("title")
        .eq("id", eventId)
        .single();
      if (error || !data) throw Error("活动不存在或你没有访问权限。");
      if (!active) return;
      setUserId(user.id);
      setTitle(data.title);
      await reload();
      if (active) setMessage("");
    })().catch((e) => {
      if (active) setMessage(e.message);
    });
    return () => {
      active = false;
    };
  }, [eventId]);
  async function action(run: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setMessage("");
    try {
      await run();
      await reload();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "保存失败，请重试。");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function add() {
    await action(async () => {
      if (!userId) throw Error("请先登录。");
      if (kind === "note" && !newTitle.trim() && !body.trim())
        throw Error("请输入文字或标题。");
      if (kind === "link") {
        let parsed;
        try {
          parsed = new URL(url);
        } catch {
          throw Error("请输入完整的 http:// 或 https:// 链接。");
        }
        if (!["http:", "https:"].includes(parsed.protocol))
          throw Error("仅支持 HTTP(S) 链接。");
      }
      if (
        kind === "image" &&
        (!file ||
          !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(
            file.type,
          ) ||
          file.size > 8388608)
      )
        throw Error("请选择不超过8 MB的 PNG、JPEG、WebP 或 GIF 图片。");
      const db = browserDB();
      let path: string | null = null;
      if (kind === "image" && file) {
        const ext = (
          {
            "image/png": "png",
            "image/jpeg": "jpg",
            "image/webp": "webp",
            "image/gif": "gif",
          } as Record<string, string>
        )[file.type];
        path = `${userId}/${eventId}/${crypto.randomUUID()}.${ext}`;
        const upload = await db.storage
          .from("event-board")
          .upload(path, file, { contentType: file.type, upsert: false });
        if (upload.error)
          throw Error("图片上传失败，请检查存储配置或文件大小。");
      }
      const { error } = await db
        .from("event_board_cards")
        .insert({
          event_id: eventId,
          user_id: userId,
          kind,
          title: newTitle.trim(),
          body,
          url: kind === "link" ? url.trim() : null,
          image_path: path,
          x: 40 + (cards.length % 5) * 300,
          y: 40 + (Math.floor(cards.length / 5) % 5) * 300,
        });
      if (error) {
        if (path) await db.storage.from("event-board").remove([path]);
        throw Error("卡片保存失败，文字尚未清空，请稍后重试。");
      }
      setNewTitle("");
      setBody("");
      setURL("");
      setFile(null);
      if (fileInput.current) fileInput.current.value = "";
    });
  }
  async function save(card: Card, patch: Partial<Card>) {
    await action(async () => {
      const { error } = await browserDB()
        .from("event_board_cards")
        .update(patch)
        .eq("id", card.id)
        .eq("event_id", eventId);
      if (error) throw Error("修改未保存，请重试。");
    });
  }
  function finishDrag(
    e: React.PointerEvent<HTMLButtonElement>,
    cancel = false,
  ) {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId) return;
    drag.current = null;
    const x = cancel
      ? d.x
      : Math.max(0, Math.min(1700, Math.round(d.x + e.clientX - d.startX)));
    const y = cancel
      ? d.y
      : Math.max(0, Math.min(1700, Math.round(d.y + e.clientY - d.startY)));
    const card = cards.find((c) => c.id === d.id);
    if (card) void save(card, { x, y });
  }
  return (
    <main className="board-page">
      <Link href="/">← 返回日历</Link>
      <p className="eyebrow">事件资料 · 私人看板</p>
      <h1>{title}</h1>
      <p className="muted">
        记录想法、图片和来源，拖动卡片整理思路，连接相关资料。图片使用私有存储；外部链接由你点击后打开。
      </p>
      <p role="status" aria-live="polite">
        {message}
      </p>
      {userId && (
        <>
          <form
            className="panel board-composer"
            onSubmit={(e) => {
              e.preventDefault();
              void add();
            }}
          >
            <label>
              卡片类型
              <select
                value={kind}
                onChange={(e) => setKind(e.target.value as Card["kind"])}
                disabled={busy}
              >
                <option value="note">文字便签</option>
                <option value="image">图片</option>
                <option value="link">链接</option>
              </select>
            </label>
            <label>
              标题
              <input
                maxLength={200}
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                disabled={busy}
              />
            </label>
            <label>
              文字 / 图片说明
              <textarea
                maxLength={10000}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                disabled={busy}
              />
            </label>
            {kind === "link" && (
              <label>
                来源链接
                <input
                  type="url"
                  required
                  maxLength={2000}
                  value={url}
                  onChange={(e) => setURL(e.target.value)}
                  disabled={busy}
                />
              </label>
            )}
            {kind === "image" && (
              <label>
                图片（≤8 MB）
                <input
                  ref={fileInput}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  required
                  disabled={busy}
                  onChange={(e) => setFile(e.target.files?.[0] || null)}
                />
              </label>
            )}
            <button className="primary" disabled={busy}>
              {busy ? "正在保存…" : "添加到看板"}
            </button>
          </form>
          {cards.length > 1 && (
            <form
              className="panel board-links"
              onSubmit={(e) => {
                e.preventDefault();
                void action(async () => {
                  if (!from || !to || from === to)
                    throw Error("请选择两张不同卡片。");
                  const { error } = await browserDB()
                    .from("event_board_edges")
                    .insert({
                      event_id: eventId,
                      user_id: userId,
                      from_card: from,
                      to_card: to,
                    });
                  if (error) throw Error("连线未保存；请检查是否已存在。");
                  setFrom("");
                  setTo("");
                });
              }}
            >
              <label>
                从
                <select
                  value={from}
                  required
                  disabled={busy}
                  onChange={(e) => setFrom(e.target.value)}
                >
                  <option value="">选择卡片</option>
                  {cards.map((c, i) => (
                    <option key={c.id} value={c.id}>
                      {i + 1}. {c.title || c.body.slice(0, 20) || "图片"}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                到
                <select
                  value={to}
                  required
                  disabled={busy}
                  onChange={(e) => setTo(e.target.value)}
                >
                  <option value="">选择卡片</option>
                  {cards.map((c, i) => (
                    <option key={c.id} value={c.id}>
                      {i + 1}. {c.title || c.body.slice(0, 20) || "图片"}
                    </option>
                  ))}
                </select>
              </label>
              <button disabled={busy}>连接资料</button>
            </form>
          )}
          <div className="board-viewport" aria-label="可滚动事件看板">
            <div className="board-canvas">
              <svg
                className="board-wires"
                width="2000"
                height="2000"
                aria-hidden="true"
              >
                {edges.map((e) => {
                  const a = cards.find((c) => c.id === e.from_card),
                    b = cards.find((c) => c.id === e.to_card);
                  return a && b ? (
                    <line
                      key={e.id}
                      x1={a.x + 135}
                      y1={a.y + 30}
                      x2={b.x + 135}
                      y2={b.y + 30}
                    />
                  ) : null;
                })}
              </svg>
              {!cards.length && (
                <p className="board-empty">
                  从一张便签开始，把这件事的资料放在一起。
                </p>
              )}
              {cards.map((card, index) => (
                <article
                  key={card.id}
                  className={`board-card board-${card.kind}`}
                  style={{ left: card.x, top: card.y }}
                >
                  <button
                    className="board-drag"
                    aria-label={`移动卡片${index + 1}；也可用方向键移动`}
                    disabled={busy}
                    onPointerDown={(e) => {
                      if (e.button !== 0 || drag.current) return;
                      e.currentTarget.setPointerCapture(e.pointerId);
                      drag.current = {
                        id: card.id,
                        pointer: e.pointerId,
                        startX: e.clientX,
                        startY: e.clientY,
                        x: card.x,
                        y: card.y,
                      };
                    }}
                    onPointerMove={(e) => {
                      const d = drag.current;
                      if (!d || d.id !== card.id || d.pointer !== e.pointerId)
                        return;
                      setCards((cs) =>
                        cs.map((c) =>
                          c.id === d.id
                            ? {
                                ...c,
                                x: Math.max(
                                  0,
                                  Math.min(
                                    1700,
                                    Math.round(d.x + e.clientX - d.startX),
                                  ),
                                ),
                                y: Math.max(
                                  0,
                                  Math.min(
                                    1700,
                                    Math.round(d.y + e.clientY - d.startY),
                                  ),
                                ),
                              }
                            : c,
                        ),
                      );
                    }}
                    onPointerUp={(e) => finishDrag(e)}
                    onPointerCancel={(e) => finishDrag(e, true)}
                    onKeyDown={(e) => {
                      if (
                        ![
                          "ArrowLeft",
                          "ArrowRight",
                          "ArrowUp",
                          "ArrowDown",
                        ].includes(e.key)
                      )
                        return;
                      e.preventDefault();
                      void save(card, {
                        x: Math.max(
                          0,
                          Math.min(
                            1700,
                            card.x +
                              (e.key === "ArrowRight"
                                ? 20
                                : e.key === "ArrowLeft"
                                  ? -20
                                  : 0),
                          ),
                        ),
                        y: Math.max(
                          0,
                          Math.min(
                            1700,
                            card.y +
                              (e.key === "ArrowDown"
                                ? 20
                                : e.key === "ArrowUp"
                                  ? -20
                                  : 0),
                          ),
                        ),
                      });
                    }}
                  >
                    ⠿ {index + 1} ·{" "}
                    {card.kind === "image"
                      ? "图片"
                      : card.kind === "link"
                        ? "链接"
                        : "便签"}
                  </button>
                  <input
                    aria-label="卡片标题"
                    maxLength={200}
                    defaultValue={card.title}
                    key={`title-${card.title}`}
                    disabled={busy}
                    onBlur={(e) => {
                      if (e.target.value !== card.title)
                        void save(card, { title: e.target.value });
                    }}
                  />
                  {card.kind === "image" &&
                    (card.signedURL ? (
                      <img
                        src={card.signedURL}
                        alt={card.title || "事件资料图片"}
                        onError={() =>
                          setMessage("图片链接可能已过期，请刷新页面。")
                        }
                      />
                    ) : (
                      <p>图片暂时无法读取，请刷新。</p>
                    ))}
                  <textarea
                    aria-label="卡片文字"
                    maxLength={10000}
                    defaultValue={card.body}
                    key={`body-${card.body}`}
                    disabled={busy}
                    onBlur={(e) => {
                      if (e.target.value !== card.body)
                        void save(card, { body: e.target.value });
                    }}
                  />
                  {card.url && /^https?:\/\//i.test(card.url) && (
                    <a
                      href={card.url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      打开来源 ↗
                    </a>
                  )}
                  <button
                    disabled={busy}
                    onClick={() => {
                      if (window.confirm("删除这张卡片及其连线？"))
                        void action(async () => {
                          const db = browserDB();
                          const { error } = await db
                            .from("event_board_cards")
                            .delete()
                            .eq("id", card.id)
                            .eq("event_id", eventId);
                          if (error) throw Error("删除失败。");
                          if (card.image_path) {
                            const removed = await db.storage
                              .from("event-board")
                              .remove([card.image_path]);
                            if (removed.error)
                              setMessage("卡片已删除，但图片文件清理失败。");
                          }
                        });
                    }}
                  >
                    删除卡片
                  </button>
                </article>
              ))}
            </div>
          </div>
          {edges.length > 0 && (
            <details className="panel">
              <summary>管理连线（{edges.length}）</summary>
              {edges.map((e) => (
                <p key={e.id}>
                  {cards.find((c) => c.id === e.from_card)?.title || "便签"} →{" "}
                  {cards.find((c) => c.id === e.to_card)?.title || "便签"}{" "}
                  <button
                    disabled={busy}
                    onClick={() =>
                      void action(async () => {
                        const { error } = await browserDB()
                          .from("event_board_edges")
                          .delete()
                          .eq("id", e.id);
                        if (error) throw Error("删除连线失败。");
                      })
                    }
                  >
                    移除连线
                  </button>
                </p>
              ))}
            </details>
          )}
        </>
      )}
    </main>
  );
}
