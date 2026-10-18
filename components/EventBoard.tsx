"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import PdfReader from "./PdfReader";
import { deleteOwned, cleanupFiles } from "@/lib/deletion-client";
import AnnotationSurface from "./AnnotationSurface";
import {
  cardWidth,
  edgeAnchors,
  resizedWidth,
  LONG_PRESS_MS,
  highlightColors,
  type HighlightColor,
} from "@/lib/board-interactions";
import { browserDB, configured } from "@/lib/supabase";
import { dragPosition, zoomValue, nextCardPosition } from "@/lib/knowledge";
const boardPosition = (
  origin: { x: number; y: number },
  delta: { x: number; y: number },
  zoom: number,
) => dragPosition(origin, delta, zoom, 20000);
type Card = {
  id: string;
  kind: "note" | "link" | "image" | "pdf";
  title: string;
  body: string;
  url: string | null;
  image_path: string | null;
  original_filename: string | null;
  color: "yellow" | "pink" | "blue" | "green";
  x: number;
  y: number;
  display_width?: number;
  pdf_page?: number;
  signedURL?: string;
};
type Edge = { id: string; from_card: string; to_card: string };
const types = { note: "便签", image: "图片", link: "链接", pdf: "PDF" };
const mimes: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "application/pdf": "pdf",
};
export default function EventBoard({ eventId }: { eventId: string }) {
  const [userId, setUserId] = useState(""),
    [title, setTitle] = useState("事件看板"),
    [cards, setCards] = useState<Card[]>([]),
    [edges, setEdges] = useState<Edge[]>([]);
  const [message, setMessage] = useState("正在读取…"),
    [busy, setBusy] = useState(false),
    [composer, setComposer] = useState(false),
    [linker, setLinker] = useState(false),
    [zoom, setZoom] = useState(1);
  const [kind, setKind] = useState<Card["kind"]>("note"),
    [newTitle, setNewTitle] = useState(""),
    [body, setBody] = useState(""),
    [url, setURL] = useState(""),
    [file, setFile] = useState<File | null>(null),
    [color, setColor] = useState<Card["color"]>("yellow"),
    [editing, setEditing] = useState<Card | null>(null);
  const [from, setFrom] = useState(""),
    [to, setTo] = useState("");
  const [annotationEnabled, setAnnotationEnabled] = useState(false);
  const [annotationCommand, setAnnotationCommand] = useState<{
    id: number;
    target: string;
    kind: "undo" | "restore";
  }>();
  const [annotationTool, setAnnotationTool] = useState<"pen" | "eraser">("pen");
  const [highlightCard, setHighlightCard] = useState(""),
    [penColor, setPenColor] = useState<HighlightColor>("yellow");
  const [preview, setPreview] = useState<{
    source: string;
    x: number;
    y: number;
    target: string | null;
  } | null>(null);
  const [newOrigin, setNewOrigin] = useState<{
    source: string;
    position: { x: number; y: number };
  } | null>(null);
  const press = useRef<{
    source: string;
    pointer: number;
    startX: number;
    startY: number;
    active: boolean;
    timer?: ReturnType<typeof setTimeout>;
  } | null>(null);
  const suppressClick = useRef(false);
  const resize = useRef<{
    id: string;
    pointer: number;
    startX: number;
    width: number;
  } | null>(null);
  const [scene, setScene] = useState({ width: 3200, height: 3200 });
  const focused = useRef(false);
  const viewport = useRef<HTMLDivElement>(null),
    fileInput = useRef<HTMLInputElement>(null),
    lock = useRef(false);
  const drag = useRef<{
    id: string;
    pointer: number;
    startX: number;
    startY: number;
    x: number;
    y: number;
  } | null>(null);
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
      throw Error("看板无法读取，请稍后刷新；若持续失败，请检查看板迁移。");
    const data = await Promise.all(
      (c.data as Card[]).map(async (c) => {
        if (!c.image_path) return c;
        const r = await db.storage
          .from("event-board")
          .createSignedUrl(c.image_path, 3600);
        return { ...c, signedURL: r.data?.signedUrl };
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
      if (!user) throw Error("请先返回日历登录。");
      const { data, error } = await db
        .from("events")
        .select("title")
        .is("deleted_at", null)
        .eq("id", eventId)
        .single();
      if (error || !data) throw Error("活动不存在或没有访问权限。");
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
  useEffect(() => {
    if (focused.current || !cards.length) return;
    const id = window.location.hash.slice(1);
    const card = cards.find((c) => `card-${c.id}` === id);
    if (!card) return;
    focused.current = true;
    setZoom(1);
    requestAnimationFrame(() => {
      if (viewport.current) {
        viewport.current.scrollLeft = Math.max(0, card.x - 40);
        viewport.current.scrollTop = Math.max(0, card.y - 40);
      }
    });
  }, [cards]);
  useEffect(() => {
    const root = viewport.current;
    if (!root) return;
    const measure = () => {
      let width = 3200,
        height = 3200;
      root.querySelectorAll<HTMLElement>(".board-card").forEach((el) => {
        width = Math.max(width, el.offsetLeft + el.offsetWidth + 100);
        height = Math.max(height, el.offsetTop + el.offsetHeight + 100);
      });
      setScene((old) =>
        old.width === width && old.height === height ? old : { width, height },
      );
    };
    const observer = new ResizeObserver(measure);
    root.querySelectorAll(".board-card").forEach((el) => observer.observe(el));
    measure();
    return () => observer.disconnect();
  }, [cards]);
  function changeZoom(value: number, point?: { x: number; y: number }) {
    const next = zoomValue(value),
      el = viewport.current;
    if (!el) {
      setZoom(next);
      return;
    }
    const cx = point?.x ?? el.clientWidth / 2,
      cy = point?.y ?? el.clientHeight / 2;
    const worldX = (el.scrollLeft + cx) / zoom,
      worldY = (el.scrollTop + cy) / zoom;
    setZoom(next);
    requestAnimationFrame(() => {
      el.scrollLeft = worldX * next - cx;
      el.scrollTop = worldY * next - cy;
    });
  }
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      changeZoom(zoom * (e.deltaY > 0 ? 0.9 : 1.1), {
        x: e.clientX - r.left,
        y: e.clientY - r.top,
      });
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, [zoom, userId]);
  async function action(run: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setMessage("");
    try {
      await run();
      await reload();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "操作失败，请重试。");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  function startNew(type: Card["kind"], origin: typeof newOrigin = null) {
    setNewOrigin(origin);
    setEditing(null);
    setKind(type);
    setNewTitle("");
    setBody("");
    setURL("");
    setFile(null);
    setComposer(true);
  }
  function editCard(c: Card) {
    setNewOrigin(null);
    setEditing(c);
    setKind(c.kind);
    setNewTitle(c.title);
    setBody(c.body);
    setURL(c.url || "");
    setColor(c.color || "yellow");
    setFile(null);
    setComposer(true);
  }
  async function submit() {
    await action(async () => {
      if (!userId) throw Error("请先登录。");
      if (kind === "note" && !newTitle.trim() && !body.trim())
        throw Error("请写一点内容。");
      let link: string | null = null;
      if (kind === "link") {
        try {
          const u = new URL(url);
          if (!["http:", "https:"].includes(u.protocol)) throw Error();
          link = u.href;
        } catch {
          throw Error("请输入完整 HTTP(S) 链接。");
        }
      }
      const db = browserDB();
      if (editing) {
        const { error } = await db
          .from("event_board_cards")
          .update({ title: newTitle.trim(), body, url: link, color })
          .eq("id", editing.id)
          .eq("event_id", eventId)
          .select("id")
          .single();
        if (error) throw Error("未能保存修改，草稿已保留。");
      } else if (newOrigin) {
        const { error } = await db.rpc("create_linked_board_note", {
          source_card: newOrigin.source,
          note_title: newTitle.trim(),
          note_body: body,
          position_x: newOrigin.position.x,
          position_y: newOrigin.position.y,
          note_color: color,
        });
        if (error) throw Error("新便签及连线未保存，输入内容已保留。");
      } else {
        let path: string | null = null;
        if (kind === "image" || kind === "pdf") {
          if (
            !file ||
            file.size > 8388608 ||
            !mimes[file.type] ||
            (kind === "pdf"
              ? file.type !== "application/pdf"
              : !file.type.startsWith("image/"))
          )
            throw Error("请选择8 MB以内的图片或 PDF，文件类型需与卡片一致。");
          if (kind === "pdf") {
            const header = new TextDecoder().decode(
              await file.slice(0, 5).arrayBuffer(),
            );
            if (header !== "%PDF-") throw Error("这不是有效的 PDF 文件。");
          }
          path = `${userId}/${eventId}/${crypto.randomUUID()}.${mimes[file.type]}`;
          const upload = await db.storage
            .from("event-board")
            .upload(path, file, { contentType: file.type, upsert: false });
          if (upload.error)
            throw Error("上传失败，请确认文件不超过8 MB及附件迁移已部署。");
        }
        const el = viewport.current;
        const pos = nextCardPosition(
          cards,
          boardPosition(
            { x: 0, y: 0 },
            { x: el ? el.scrollLeft + 80 : 40, y: el ? el.scrollTop + 80 : 40 },
            zoom,
          ),
        );
        const { error } = await db.from("event_board_cards").insert({
          user_id: userId,
          event_id: eventId,
          kind,
          title: newTitle.trim(),
          body,
          url: link,
          color,
          image_path: path,
          original_filename: path ? file?.name.slice(0, 255) : null,
          display_width: cardWidth({ kind }),
          ...pos,
        });
        if (error) {
          if (path) await db.storage.from("event-board").remove([path]);
          throw Error("卡片未能保存，输入内容已保留。");
        }
      }
      setNewOrigin(null);
      setComposer(false);
      setEditing(null);
      setNewTitle("");
      setBody("");
      setURL("");
      setFile(null);
      if (fileInput.current) fileInput.current.value = "";
    });
  }
  async function moveCard(card: Card, pos: { x: number; y: number }) {
    await action(async () => {
      const r = await browserDB()
        .from("event_board_cards")
        .update(pos)
        .eq("id", card.id)
        .eq("event_id", eventId)
        .select("id")
        .single();
      if (r.error) {
        await reload();
        throw Error("位置没有保存，已恢复数据库位置。");
      }
    });
  }
  function finishDrag(
    e: React.PointerEvent<HTMLButtonElement>,
    cancel = false,
  ) {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId) return;
    drag.current = null;
    const c = cards.find((c) => c.id === d.id);
    if (c)
      void moveCard(
        c,
        cancel
          ? { x: d.x, y: d.y }
          : boardPosition(
              d,
              { x: e.clientX - d.startX, y: e.clientY - d.startY },
              zoom,
            ),
      );
  }
  async function persistView(
    card: Card,
    patch: { display_width?: number; pdf_page?: number },
    rollback = patch.display_width === undefined
      ? { pdf_page: card.pdf_page || 1 }
      : { display_width: card.display_width || cardWidth(card) },
  ) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setMessage("");
    setCards((cs) =>
      cs.map((c) => (c.id === card.id ? { ...c, ...patch } : c)),
    );
    try {
      const r = await browserDB()
        .from("event_board_cards")
        .update(patch)
        .eq("id", card.id)
        .eq("event_id", eventId)
        .select("id")
        .single();
      if (r.error) throw Error();
    } catch {
      setCards((cs) =>
        cs.map((c) => (c.id === card.id ? { ...c, ...rollback } : c)),
      );
      setMessage("视图更改未保存，已恢复原状态。");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function connectCards(source: string, target: string) {
    await action(async () => {
      const r = await browserDB().rpc("connect_board_cards", {
        source_card: source,
        target_card: target,
      });
      if (r.error)
        throw Error(
          r.error.code === "PGRST202"
            ? "连线数据库更新尚未部署，请稍后刷新。"
            : "连线未保存，请刷新后重试。",
        );
      setMessage("已连接，两张卡片的关系已保存。");
    });
  }
  function worldPoint(x: number, y: number) {
    const el = viewport.current?.querySelector(".board-canvas");
    if (!el) return { x: 0, y: 0 };
    const rect = el.getBoundingClientRect();
    return { x: (x - rect.left) / zoom, y: (y - rect.top) / zoom };
  }
  function targetCard(x: number, y: number) {
    return (
      document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-card-id]")
        ?.dataset.cardId || null
    );
  }
  function beginConnection(
    e: React.PointerEvent<HTMLElement>,
    card: Card,
    immediate = false,
  ) {
    if (
      e.button !== 0 ||
      busy ||
      press.current ||
      drag.current ||
      resize.current ||
      annotationEnabled
    )
      return;
    if (
      !immediate &&
      (e.target as Element).closest(
        "button,a,input,textarea,select,[data-no-connect]",
      )
    )
      return;
    if (immediate) {
      e.stopPropagation();
      e.preventDefault();
    }
    suppressClick.current = false;
    e.currentTarget.setPointerCapture(e.pointerId);
    const state = {
      source: card.id,
      pointer: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      active: immediate,
      timer: undefined as ReturnType<typeof setTimeout> | undefined,
    };
    press.current = state;
    const activate = () => {
      if (press.current !== state) return;
      state.active = true;
      suppressClick.current = true;
      const point = worldPoint(state.startX, state.startY);
      setPreview({ source: card.id, ...point, target: null });
      setMessage("拖到另一张卡片连线，或拖到空白处新建便签。");
    };
    if (immediate) activate();
    else state.timer = setTimeout(activate, LONG_PRESS_MS);
  }
  function moveConnection(e: React.PointerEvent<HTMLElement>) {
    const p = press.current;
    if (!p || p.pointer !== e.pointerId) return;
    if (!p.active) {
      if (Math.hypot(e.clientX - p.startX, e.clientY - p.startY) > 8) {
        clearTimeout(p.timer);
        press.current = null;
      }
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const point = worldPoint(e.clientX, e.clientY);
    const target = targetCard(e.clientX, e.clientY);
    setPreview({
      source: p.source,
      ...point,
      target: target === p.source ? null : target,
    });
  }
  function endConnection(e: React.PointerEvent<HTMLElement>, cancel = false) {
    const p = press.current;
    if (!p || p.pointer !== e.pointerId) return;
    clearTimeout(p.timer);
    press.current = null;
    setPreview(null);
    setTimeout(() => {
      suppressClick.current = false;
    }, 0);
    if (!p.active || cancel) return;
    e.preventDefault();
    e.stopPropagation();
    const target = targetCard(e.clientX, e.clientY);
    if (target && target !== p.source) {
      void connectCards(p.source, target);
      return;
    }
    if (
      !target &&
      document.elementFromPoint(e.clientX, e.clientY)?.closest(".board-canvas")
    ) {
      const point = worldPoint(e.clientX, e.clientY);
      startNew("note", {
        source: p.source,
        position: boardPosition({ x: 0, y: 0 }, point, 1),
      });
      setMessage("输入便签内容，保存后自动连接；收起或取消不会创建空便签。");
    }
  }
  useEffect(
    () => () => {
      if (press.current) clearTimeout(press.current.timer);
    },
    [],
  );
  function fit() {
    const el = viewport.current;
    if (!el) return;
    const maxX = Math.max(700, ...cards.map((c) => c.x + cardWidth(c) + 40)),
      maxY = Math.max(
        400,
        ...cards.map(
          (c) => c.y + (c.kind === "pdf" ? cardWidth(c) * 1.5 + 200 : 650),
        ),
      );
    setZoom(zoomValue(Math.min(el.clientWidth / maxX, el.clientHeight / maxY)));
    requestAnimationFrame(() => {
      el.scrollLeft = 0;
      el.scrollTop = 0;
    });
  }
  return (
    <main className="board-page board-workspace">
      <header className="board-header">
        <div>
          <Link href="/">← 日历</Link>
          <span className="board-separator"> / </span>
          <Link href="/search">搜索与关联</Link>
          <span className="board-separator"> / </span>
          <Link href={`/notes?event=${eventId}`}>课程笔记</Link>
          <h1>{title}</h1>
        </div>
        <span className="muted">私人资料墙</span>
      </header>
      <p role="status" aria-live="polite" className="board-status">
        {message || (busy ? "正在保存…" : "")}
      </p>
      {userId && (
        <>
          <div className="board-toolbar" role="toolbar" aria-label="看板工具">
            {(Object.keys(types) as Card["kind"][]).map((k) => (
              <button key={k} disabled={busy} onClick={() => startNew(k)}>
                ＋ {types[k]}
              </button>
            ))}
            <button
              aria-expanded={composer}
              aria-controls="board-composer"
              onClick={() => setComposer(!composer)}
            >
              {composer ? "收起输入区" : "展开输入区"}
            </button>
            <button aria-expanded={linker} onClick={() => setLinker(!linker)}>
              连接资料
            </button>
            <div
              className="board-drawing-tools"
              role="group"
              aria-label="批注工具"
            >
              <button
                aria-pressed={!annotationEnabled}
                onClick={() => setAnnotationEnabled(false)}
              >
                选择 / 移动
              </button>
              <button
                aria-pressed={annotationEnabled && annotationTool === "pen"}
                onClick={() => {
                  setAnnotationTool("pen");
                  setAnnotationEnabled(true);
                }}
              >
                荧光笔
              </button>
              <button
                aria-pressed={annotationEnabled && annotationTool === "eraser"}
                title="拖过笔迹，整笔擦除"
                onClick={() => {
                  setAnnotationTool("eraser");
                  setAnnotationEnabled(true);
                }}
              >
                橡皮擦
              </button>
              <button
                disabled={!highlightCard}
                title="撤销最近操作的资料当前页上的一笔"
                onClick={() =>
                  setAnnotationCommand({
                    id: Date.now(),
                    target: highlightCard,
                    kind: "undo",
                  })
                }
              >
                撤销一笔
              </button>
              <button
                disabled={!highlightCard}
                title="恢复最近操作的资料当前页上的擦除"
                onClick={() =>
                  setAnnotationCommand({
                    id: Date.now(),
                    target: highlightCard,
                    kind: "restore",
                  })
                }
              >
                撤销擦除
              </button>
            </div>
            <label className="board-pen-color">
              笔色
              <select
                aria-label="荧光笔颜色"
                value={penColor}
                onChange={(e) => setPenColor(e.target.value as HighlightColor)}
              >
                {Object.keys(highlightColors).map((c) => (
                  <option key={c} value={c}>
                    {{ yellow: "黄", pink: "粉", green: "绿", blue: "蓝" }[c]}
                  </option>
                ))}
              </select>
            </label>
            <span className="board-toolbar-spacer" />
            <button
              onClick={() => changeZoom(zoom - 0.1)}
              disabled={zoom <= 0.3}
              aria-label="缩小看板"
            >
              −
            </button>
            <button onClick={() => changeZoom(1)} aria-label="重置缩放">
              {Math.round(zoom * 100)}%
            </button>
            <button
              onClick={() => changeZoom(zoom + 0.1)}
              disabled={zoom >= 2}
              aria-label="放大看板"
            >
              ＋
            </button>
            <button onClick={fit}>适应内容</button>
            <button
              disabled={busy}
              onClick={() => {
                if (
                  !window.confirm(
                    "清空此事件看板的全部卡片、附件、连线和笔迹？无法恢复；日程与独立课程笔记保留。",
                  )
                )
                  return;
                void action(async () => {
                  const r = await browserDB().rpc("clear_event_board", {
                    target: eventId,
                  });
                  if (r.error) throw Error("清空失败");
                  const failed = await cleanupFiles();
                  if (failed)
                    setMessage("看板已清空，部分附件待清理，可到回收站重试。");
                });
              }}
            >
              清空看板
            </button>
          </div>
          <p className="board-gesture-hint">
            长按卡片后拖动连线；拖到空白处新建便签。⠿
            移动位置，右下角等比调整图片 / PDF。
          </p>
          <div className={`board-layout ${composer ? "with-composer" : ""}`}>
            {composer && (
              <aside className="board-drawer" id="board-composer">
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void submit();
                  }}
                >
                  <div className="board-drawer-heading">
                    <h2>
                      {editing ? "编辑" : "添加"}
                      {types[kind]}
                    </h2>
                    <button
                      type="button"
                      onClick={() => setComposer(false)}
                      aria-label="收起输入区"
                    >
                      ×
                    </button>
                  </div>
                  {newOrigin && (
                    <p className="notice">
                      保存后连接到「
                      {cards.find((c) => c.id === newOrigin.source)?.title ||
                        "原卡片"}
                      」。
                      <button
                        type="button"
                        onClick={() => {
                          setNewOrigin(null);
                          setComposer(false);
                        }}
                      >
                        取消新建
                      </button>
                    </p>
                  )}
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
                    {kind === "image"
                      ? "图片下方的文字记录"
                      : kind === "pdf"
                        ? "摘要 / 阅读笔记"
                        : "记录"}
                    <textarea
                      maxLength={10000}
                      rows={6}
                      value={body}
                      onChange={(e) => setBody(e.target.value)}
                      disabled={busy}
                      placeholder="写下想法，也可用 [[事件或卡片标题]] 建立关联"
                    />
                  </label>
                  {kind === "note" && (
                    <label>
                      便签颜色
                      <select
                        value={color}
                        disabled={busy}
                        onChange={(e) =>
                          setColor(e.target.value as Card["color"])
                        }
                      >
                        <option value="yellow">浅黄</option>
                        <option value="pink">粉色</option>
                        <option value="blue">浅蓝</option>
                        <option value="green">浅绿</option>
                      </select>
                    </label>
                  )}
                  {kind === "link" && (
                    <label>
                      来源网址
                      <input
                        type="url"
                        maxLength={2000}
                        required
                        value={url}
                        onChange={(e) => setURL(e.target.value)}
                        disabled={busy}
                      />
                    </label>
                  )}
                  {!editing && (kind === "image" || kind === "pdf") && (
                    <label>
                      {kind === "pdf" ? "PDF" : "图片"}（≤8 MB）
                      <input
                        key={kind}
                        ref={fileInput}
                        type="file"
                        accept={
                          kind === "pdf"
                            ? "application/pdf,.pdf"
                            : "image/png,image/jpeg,image/webp,image/gif"
                        }
                        required
                        disabled={busy}
                        onChange={(e) => setFile(e.target.files?.[0] || null)}
                      />
                    </label>
                  )}
                  {kind === "pdf" && (
                    <p className="muted">
                      PDF
                      原文件私有保存。可搜索标题、文件名和阅读笔记；暂不自动识别
                      PDF 正文或扫描图片。
                    </p>
                  )}
                  <button className="primary" disabled={busy}>
                    {busy ? "保存中…" : editing ? "保存修改" : "放到看板上"}
                  </button>
                </form>
              </aside>
            )}
            <div
              className="board-viewport"
              ref={viewport}
              aria-label="事件看板，可滚动；按住 Ctrl 或 Command 滚轮缩放"
            >
              <div
                className="board-stage"
                style={{
                  width: scene.width * zoom,
                  height: scene.height * zoom,
                }}
              >
                <div
                  className="board-canvas"
                  style={{
                    width: scene.width,
                    height: scene.height,
                    transform: `scale(${zoom})`,
                    transformOrigin: "top left",
                  }}
                >
                  <svg
                    className="board-wires"
                    width={scene.width}
                    height={scene.height}
                    aria-hidden="true"
                  >
                    {edges.map((e) => {
                      const a = cards.find((c) => c.id === e.from_card),
                        b = cards.find((c) => c.id === e.to_card);
                      if (!a || !b) return null;
                      const { start, end } = edgeAnchors(a, b);
                      return (
                        <path
                          key={e.id}
                          d={`M ${start.x} ${start.y} C ${(start.x + end.x) / 2} ${start.y - 40} ${(start.x + end.x) / 2} ${end.y - 40} ${end.x} ${end.y}`}
                        />
                      );
                    })}
                    {preview &&
                      (() => {
                        const source = cards.find(
                          (c) => c.id === preview.source,
                        );
                        return source ? (
                          <path
                            className="board-wire-preview"
                            d={`M ${source.x + cardWidth(source)} ${source.y + 50} L ${preview.x} ${preview.y}`}
                          />
                        ) : null;
                      })()}
                  </svg>
                  {!cards.length && (
                    <div className="board-empty">
                      <h2>让想法在这里展开</h2>
                      <p>
                        从上方添加便签、图片、链接或 PDF。输入区可随时收起。
                      </p>
                    </div>
                  )}
                  {cards.map((c, i) => (
                    <article
                      id={`card-${c.id}`}
                      key={c.id}
                      data-card-id={c.id}
                      className={`board-card board-${c.kind} paper-${c.color || "yellow"} ${preview?.target === c.id ? "connection-target" : ""}`}
                      style={{ left: c.x, top: c.y, width: cardWidth(c) }}
                      onPointerDown={(e) => beginConnection(e, c)}
                      onPointerMove={moveConnection}
                      onPointerUp={(e) => endConnection(e)}
                      onPointerCancel={(e) => endConnection(e, true)}
                      onClickCapture={(e) => {
                        if (suppressClick.current) {
                          e.preventDefault();
                          e.stopPropagation();
                          suppressClick.current = false;
                        }
                      }}
                    >
                      <div className="board-card-tools">
                        <button
                          className="board-drag"
                          aria-label={`拖动卡片${i + 1}，或用方向键移动`}
                          disabled={busy}
                          onPointerDown={(e) => {
                            if (e.button !== 0 || drag.current) return;
                            e.currentTarget.setPointerCapture(e.pointerId);
                            drag.current = {
                              id: c.id,
                              pointer: e.pointerId,
                              startX: e.clientX,
                              startY: e.clientY,
                              x: c.x,
                              y: c.y,
                            };
                          }}
                          onPointerMove={(e) => {
                            const d = drag.current;
                            if (
                              !d ||
                              d.id !== c.id ||
                              d.pointer !== e.pointerId
                            )
                              return;
                            const pos = boardPosition(
                              d,
                              {
                                x: e.clientX - d.startX,
                                y: e.clientY - d.startY,
                              },
                              zoom,
                            );
                            setCards((cs) =>
                              cs.map((card) =>
                                card.id === d.id ? { ...card, ...pos } : card,
                              ),
                            );
                          }}
                          onPointerUp={(e) => finishDrag(e)}
                          onPointerCancel={(e) => finishDrag(e, true)}
                          onKeyDown={(e) => {
                            const deltas: Record<
                              string,
                              { x: number; y: number }
                            > = {
                              ArrowLeft: { x: -20, y: 0 },
                              ArrowRight: { x: 20, y: 0 },
                              ArrowUp: { x: 0, y: -20 },
                              ArrowDown: { x: 0, y: 20 },
                            };
                            if (!deltas[e.key]) return;
                            e.preventDefault();
                            void moveCard(
                              c,
                              boardPosition(c, deltas[e.key], 1),
                            );
                          }}
                        >
                          ⠿
                        </button>
                        <button
                          className="board-connect-handle"
                          aria-label={`从卡片${i + 1}拖出连线`}
                          title="拖到另一张卡片或空白处"
                          disabled={busy}
                          onPointerDown={(e) => beginConnection(e, c, true)}
                        >
                          ↗ 连线
                        </button>
                        <button onClick={() => editCard(c)} disabled={busy}>
                          编辑
                        </button>
                        <button
                          aria-label={`删除${c.title || types[c.kind]}`}
                          disabled={busy}
                          onClick={() => {
                            if (window.confirm("删除这张卡片及其连线？"))
                              void action(async () => {
                                await deleteOwned("card", c.id);
                              });
                          }}
                        >
                          ×
                        </button>
                      </div>
                      {c.kind === "pdf" && c.signedURL && (
                        <PdfReader
                          url={c.signedURL}
                          page={c.pdf_page || 1}
                          onPage={(page) =>
                            void persistView(c, { pdf_page: page })
                          }
                          eventId={eventId}
                          cardId={c.id}
                          active={annotationEnabled}
                          color={penColor}
                          tool={annotationTool}
                          command={annotationCommand}
                          onActivate={() => setHighlightCard(c.id)}
                          onError={setMessage}
                          disabled={busy}
                        />
                      )}
                      {c.kind === "image" && (
                        <AnnotationSurface
                          eventId={eventId}
                          cardId={c.id}
                          page={0}
                          active={annotationEnabled}
                          color={penColor}
                          tool={annotationTool}
                          command={annotationCommand}
                          onActivate={() => setHighlightCard(c.id)}
                          onError={setMessage}
                        >
                          {c.signedURL ? (
                            <div className="board-photo">
                              <img
                                src={c.signedURL}
                                alt={c.title || "事件资料图片"}
                                draggable={false}
                                onError={() =>
                                  setMessage("图片链接可能已过期，请刷新页面。")
                                }
                              />
                            </div>
                          ) : (
                            <p>图片暂时无法读取，请刷新。</p>
                          )}
                        </AnnotationSurface>
                      )}
                      {c.kind === "note" ? (
                        <AnnotationSurface
                          eventId={eventId}
                          cardId={c.id}
                          page={0}
                          active={annotationEnabled}
                          color={penColor}
                          tool={annotationTool}
                          command={annotationCommand}
                          onActivate={() => setHighlightCard(c.id)}
                          onError={setMessage}
                        >
                          <div className="board-card-content board-note-surface">
                            {c.title && <h3>{c.title}</h3>}
                            {c.body && (
                              <p className="board-card-body">{c.body}</p>
                            )}
                          </div>
                        </AnnotationSurface>
                      ) : (
                        <div className="board-card-content">
                          {c.kind === "pdf" && (
                            <p className="board-pdf-label">
                              ▤ PDF · {c.original_filename}
                            </p>
                          )}
                          {c.title && <h3>{c.title}</h3>}
                          {c.body && (
                            <p className="board-card-body">{c.body}</p>
                          )}
                          {c.url && /^https?:\/\//i.test(c.url) && (
                            <a
                              href={c.url}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              打开来源 ↗
                            </a>
                          )}
                          {c.kind === "image" && c.signedURL && (
                            <a
                              href={c.signedURL}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              原图 ↗
                            </a>
                          )}
                          {c.kind === "image" && !c.body && (
                            <button
                              className="board-caption-add"
                              onClick={() => editCard(c)}
                            >
                              ＋ 添加文字记录
                            </button>
                          )}
                        </div>
                      )}
                      {(c.kind === "image" || c.kind === "pdf") && (
                        <button
                          className="board-resize"
                          aria-label={`等比调整卡片${i + 1}大小`}
                          disabled={busy}
                          onPointerDown={(e) => {
                            if (e.button !== 0) return;
                            e.stopPropagation();
                            e.preventDefault();
                            e.currentTarget.setPointerCapture(e.pointerId);
                            resize.current = {
                              id: c.id,
                              pointer: e.pointerId,
                              startX: e.clientX,
                              width: cardWidth(c),
                            };
                          }}
                          onPointerMove={(e) => {
                            const d = resize.current;
                            if (
                              !d ||
                              d.id !== c.id ||
                              d.pointer !== e.pointerId
                            )
                              return;
                            e.stopPropagation();
                            const w = resizedWidth(
                              d.width,
                              e.clientX - d.startX,
                              zoom,
                              c.kind,
                            );
                            setCards((cs) =>
                              cs.map((card) =>
                                card.id === d.id
                                  ? { ...card, display_width: w }
                                  : card,
                              ),
                            );
                          }}
                          onPointerUp={(e) => {
                            const d = resize.current;
                            if (!d || d.pointer !== e.pointerId) return;
                            e.stopPropagation();
                            resize.current = null;
                            void persistView(
                              c,
                              {
                                display_width: resizedWidth(
                                  d.width,
                                  e.clientX - d.startX,
                                  zoom,
                                  c.kind,
                                ),
                              },
                              { display_width: d.width },
                            );
                          }}
                          onPointerCancel={(e) => {
                            const d = resize.current;
                            if (!d) return;
                            e.stopPropagation();
                            resize.current = null;
                            setCards((cs) =>
                              cs.map((card) =>
                                card.id === d.id
                                  ? { ...card, display_width: d.width }
                                  : card,
                              ),
                            );
                          }}
                          onKeyDown={(e) => {
                            if (!["ArrowLeft", "ArrowRight"].includes(e.key))
                              return;
                            e.preventDefault();
                            void persistView(c, {
                              display_width: resizedWidth(
                                cardWidth(c),
                                e.key === "ArrowRight" ? 20 : -20,
                                1,
                                c.kind,
                              ),
                            });
                          }}
                        >
                          ◢
                        </button>
                      )}
                    </article>
                  ))}
                </div>
              </div>
            </div>
          </div>
          {linker && (
            <section className="panel board-connection-panel">
              <form
                className="board-links"
                onSubmit={(e) => {
                  e.preventDefault();
                  void action(async () => {
                    if (!from || !to || from === to)
                      throw Error("请选择两张不同卡片。");
                    const r = await browserDB().rpc("connect_board_cards", {
                      source_card: from,
                      target_card: to,
                    });
                    if (r.error) throw Error("连线未保存，请检查是否已存在。");
                    setFrom("");
                    setTo("");
                  });
                }}
              >
                <label>
                  从
                  <select
                    required
                    disabled={busy}
                    value={from}
                    onChange={(e) => setFrom(e.target.value)}
                  >
                    <option value="">选择卡片</option>
                    {cards.map((c, i) => (
                      <option key={c.id} value={c.id}>
                        {i + 1}.{" "}
                        {c.title ||
                          c.body.slice(0, 20) ||
                          c.original_filename ||
                          types[c.kind]}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  到
                  <select
                    required
                    disabled={busy}
                    value={to}
                    onChange={(e) => setTo(e.target.value)}
                  >
                    <option value="">选择卡片</option>
                    {cards.map((c, i) => (
                      <option key={c.id} value={c.id}>
                        {i + 1}.{" "}
                        {c.title ||
                          c.body.slice(0, 20) ||
                          c.original_filename ||
                          types[c.kind]}
                      </option>
                    ))}
                  </select>
                </label>
                <button disabled={busy}>保存连线</button>
              </form>
              {edges.map((e) => (
                <p key={e.id}>
                  {cards.find((c) => c.id === e.from_card)?.title || "便签"} →{" "}
                  {cards.find((c) => c.id === e.to_card)?.title || "便签"}{" "}
                  <button
                    disabled={busy}
                    onClick={() =>
                      void action(async () => {
                        const r = await browserDB()
                          .from("event_board_edges")
                          .delete()
                          .eq("id", e.id);
                        if (r.error) throw Error("删除连线失败。");
                      })
                    }
                  >
                    移除
                  </button>
                </p>
              ))}
              <Link href="/search">跨事件关联 → 搜索与关联</Link>
            </section>
          )}
        </>
      )}
    </main>
  );
}
