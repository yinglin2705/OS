"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { browserDB } from "@/lib/supabase";
import {
  highlightColors,
  highlightPoints,
  normalizedPoint,
  erasedStrokeIds,
  type HighlightColor,
  type AnnotationTool,
} from "@/lib/board-interactions";
type Point = [number, number];
type Stroke = {
  id: string;
  color: HighlightColor;
  points: Point[];
  created_at?: string;
};
const fields = "id,color,points,created_at";
export default function AnnotationSurface({
  eventId,
  cardId,
  page,
  active,
  color,
  tool,
  onToolChange,
  onToggle,
  onError,
  children,
  disabled = false,
}: {
  eventId: string;
  cardId: string;
  page: number;
  active: boolean;
  color: HighlightColor;
  tool: AnnotationTool;
  onToolChange: (t: AnnotationTool) => void;
  onToggle: () => void;
  onError: (s: string) => void;
  children: ReactNode;
  disabled?: boolean;
}) {
  const [strokes, setStrokes] = useState<Stroke[]>([]),
    [draft, setDraft] = useState<Point[]>([]),
    [saving, setSaving] = useState(false),
    [loading, setLoading] = useState(true),
    [unavailable, setUnavailable] = useState(false);
  const [erasePreview, setErasePreview] = useState<Set<string>>(new Set()),
    [erased, setErased] = useState<Stroke[][]>([]);
  const [cursor, setCursor] = useState<{
    point: Point;
    rx: number;
    ry: number;
  } | null>(null);
  const drawing = useRef<{
      pointer: number;
      points: Point[];
      tool: AnnotationTool;
      erasures: Set<string>;
    } | null>(null),
    lock = useRef(false);
  const enabled = active && !saving && !loading && !unavailable && !disabled;
  useEffect(() => {
    let live = true;
    setLoading(true);
    setUnavailable(false);
    setStrokes([]);
    setErased([]);
    browserDB()
      .from("board_highlights")
      .select(fields)
      .eq("card_id", cardId)
      .eq("page", page)
      .order("created_at")
      .then(({ data, error }) => {
        if (!live) return;
        if (error) {
          setUnavailable(true);
          onError("批注无法读取，请检查迁移或刷新页面。");
        } else setStrokes(data || []);
        setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [cardId, page]);
  useEffect(() => {
    if (!active) {
      drawing.current = null;
      setDraft([]);
      setErasePreview(new Set());
      setCursor(null);
    }
  }, [active]);
  function pickTool(next: AnnotationTool) {
    setCursor(null);
    if (active && tool === next) onToggle();
    else {
      onToolChange(next);
      if (!active) onToggle();
    }
  }
  async function reloadAfterFailure() {
    const r = await browserDB()
      .from("board_highlights")
      .select(fields)
      .eq("card_id", cardId)
      .eq("page", page)
      .order("created_at");
    if (r.error) {
      setUnavailable(true);
      return;
    }
    setStrokes(r.data || []);
  }
  function eraseAt(
    trail: Point[],
    rect: DOMRect,
    d: NonNullable<typeof drawing.current>,
  ) {
    for (const id of erasedStrokeIds(strokes, trail, rect)) d.erasures.add(id);
    setErasePreview(new Set(d.erasures));
  }
  async function finish(e: React.PointerEvent<SVGSVGElement>, cancel = false) {
    const d = drawing.current;
    if (!d || d.pointer !== e.pointerId) return;
    e.stopPropagation();
    drawing.current = null;
    setDraft([]);
    setErasePreview(new Set());
    if (cancel || lock.current) return;
    if (d.tool === "eraser") {
      const point = normalizedPoint(
        e.clientX,
        e.clientY,
        e.currentTarget.getBoundingClientRect(),
      );
      for (const id of erasedStrokeIds(
        strokes,
        [d.points.at(-1)!, point],
        e.currentTarget.getBoundingClientRect(),
      ))
        d.erasures.add(id);
      if (!d.erasures.size) return;
    }
    lock.current = true;
    setSaving(true);
    try {
      if (d.tool === "eraser") {
        const { data, error } = await browserDB()
          .from("board_highlights")
          .delete()
          .in("id", [...d.erasures])
          .eq("card_id", cardId)
          .eq("page", page)
          .select(fields);
        if (error) throw Error();
        const removed = (data || []) as Stroke[];
        const ids = new Set(removed.map((s) => s.id));
        setStrokes((s) => s.filter((stroke) => !ids.has(stroke.id)));
        if (removed.length) setErased((history) => [...history, removed]);
      } else {
        const points = highlightPoints.parse(d.points);
        const { data, error } = await browserDB()
          .from("board_highlights")
          .insert({ event_id: eventId, card_id: cardId, page, color, points })
          .select(fields)
          .single();
        if (error || !data) throw Error();
        setStrokes((s) => [...s, data]);
      }
    } catch {
      await reloadAfterFailure().catch(() => setUnavailable(true));
      onError(
        d.tool === "eraser"
          ? "擦除结果未确认，已重新核对批注；请检查后重试。"
          : "这笔批注未确认，请检查后重画。",
      );
    } finally {
      lock.current = false;
      setSaving(false);
    }
  }
  async function undoErase() {
    const batch = erased.at(-1);
    if (lock.current || !batch) return;
    lock.current = true;
    setSaving(true);
    try {
      const rows = batch.map((s) => ({
        ...s,
        event_id: eventId,
        card_id: cardId,
        page,
      }));
      const r = await browserDB()
        .from("board_highlights")
        .insert(rows)
        .select(fields);
      if (r.error) throw Error();
      setStrokes((s) =>
        [...s, ...(r.data || [])].sort((a, b) =>
          (a.created_at || "").localeCompare(b.created_at || ""),
        ),
      );
      setErased((s) => s.slice(0, -1));
    } catch {
      await reloadAfterFailure().catch(() => setUnavailable(true));
      onError("恢复擦除未确认，已重新核对批注，请检查后重试。");
    } finally {
      lock.current = false;
      setSaving(false);
    }
  }
  const path = (points: Point[]) =>
    points
      .map(([x, y], i) => `${i ? "L" : "M"} ${x * 1000} ${y * 1000}`)
      .join(" ") + (points.length === 1 ? " l 0.1 0.1" : "");
  return (
    <div className={`annotation-unit ${active ? "annotation-active" : ""}`}>
      <div className="annotation-tools" data-no-connect>
        <button
          disabled={loading || unavailable || saving || disabled}
          aria-pressed={active && tool === "pen"}
          onClick={() => pickTool("pen")}
        >
          {active && tool === "pen" ? "退出荧光笔" : "荧光笔"}
        </button>
        <button
          disabled={loading || unavailable || saving || disabled}
          aria-pressed={active && tool === "eraser"}
          title="拖过笔迹，整笔擦除"
          onClick={() => pickTool("eraser")}
        >
          {active && tool === "eraser" ? "退出橡皮擦" : "橡皮擦"}
        </button>
        <button
          disabled={
            loading || unavailable || saving || disabled || !erased.length
          }
          onClick={() => void undoErase()}
        >
          撤销擦除
        </button>
        <button
          disabled={loading || saving || disabled || !strokes.length}
          onClick={async () => {
            if (lock.current) return;
            lock.current = true;
            setSaving(true);
            const last = strokes.at(-1)!;
            try {
              const r = await browserDB()
                .from("board_highlights")
                .delete()
                .eq("id", last.id)
                .eq("card_id", cardId)
                .eq("page", page);
              if (r.error) throw Error();
              setStrokes((s) => s.filter((x) => x.id !== last.id));
              setErased((s) => [...s, [last]]);
            } catch {
              await reloadAfterFailure().catch(() => setUnavailable(true));
              onError("撤销结果未确认，请检查后重试。");
            } finally {
              lock.current = false;
              setSaving(false);
            }
          }}
        >
          撤销一笔
        </button>
        {saving && <span role="status">保存中…</span>}
      </div>
      <div className="annotation-surface">
        {children}
        <svg
          className={`highlight-overlay ${active && tool === "eraser" ? "eraser-mode" : ""}`}
          data-no-connect
          viewBox="0 0 1000 1000"
          preserveAspectRatio="none"
          aria-label={
            active
              ? tool === "eraser"
                ? "橡皮擦批注画布"
                : "荧光批注画布"
              : "已保存的荧光批注"
          }
          style={{ pointerEvents: enabled ? "auto" : "none" }}
          onPointerDown={(e) => {
            if (e.button !== 0 || !enabled || drawing.current) return;
            e.preventDefault();
            e.stopPropagation();
            e.currentTarget.setPointerCapture(e.pointerId);
            const rect = e.currentTarget.getBoundingClientRect();
            const point = normalizedPoint(e.clientX, e.clientY, rect);
            const d = {
              pointer: e.pointerId,
              points: [point],
              tool,
              erasures: new Set<string>(),
            };
            drawing.current = d;
            if (tool === "eraser") {
              eraseAt([point], rect, d);
              setCursor({
                point,
                rx: 10000 / Math.max(1, rect.width),
                ry: 10000 / Math.max(1, rect.height),
              });
            } else setDraft([point]);
          }}
          onPointerMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect(),
              point = normalizedPoint(e.clientX, e.clientY, rect);
            if (active && tool === "eraser")
              setCursor({
                point,
                rx: 10000 / Math.max(1, rect.width),
                ry: 10000 / Math.max(1, rect.height),
              });
            const d = drawing.current;
            if (!d || d.pointer !== e.pointerId) return;
            e.stopPropagation();
            if (d.tool === "eraser") {
              eraseAt([d.points.at(-1)!, point], rect, d);
              d.points = [point];
            } else {
              if (d.points.length >= 512) return;
              d.points.push(point);
              setDraft([...d.points]);
            }
          }}
          onPointerLeave={() => {
            if (!drawing.current) setCursor(null);
          }}
          onPointerUp={(e) => void finish(e)}
          onPointerCancel={(e) => void finish(e, true)}
        >
          {strokes.map((s) => (
            <path
              key={s.id}
              d={path(s.points)}
              stroke={highlightColors[s.color]}
              className={erasePreview.has(s.id) ? "erase-preview" : undefined}
            />
          ))}
          {draft.length > 0 && (
            <path d={path(draft)} stroke={highlightColors[color]} />
          )}
          {active && tool === "eraser" && cursor && (
            <ellipse
              className="eraser-cursor"
              cx={cursor.point[0] * 1000}
              cy={cursor.point[1] * 1000}
              rx={cursor.rx}
              ry={cursor.ry}
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>
      </div>
    </div>
  );
}
