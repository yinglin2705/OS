"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { browserDB } from "@/lib/supabase";
import {
  highlightColors,
  highlightPoints,
  normalizedPoint,
  type HighlightColor,
} from "@/lib/board-interactions";
type Stroke = { id: string; color: HighlightColor; points: [number, number][] };
export default function AnnotationSurface({
  eventId,
  cardId,
  page,
  active,
  color,
  onToggle,
  onError,
  children,
}: {
  eventId: string;
  cardId: string;
  page: number;
  active: boolean;
  color: HighlightColor;
  onToggle: () => void;
  onError: (s: string) => void;
  children: ReactNode;
}) {
  const [strokes, setStrokes] = useState<Stroke[]>([]),
    [draft, setDraft] = useState<[number, number][]>([]),
    [saving, setSaving] = useState(false),
    [loading, setLoading] = useState(true),
    [unavailable, setUnavailable] = useState(false);
  const drawing = useRef<{
    pointer: number;
    points: [number, number][];
  } | null>(null);
  const lock = useRef(false);
  useEffect(() => {
    let live = true;
    setLoading(true);
    setUnavailable(false);
    setStrokes([]);
    browserDB()
      .from("board_highlights")
      .select("id,color,points")
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
  async function finish(e: React.PointerEvent<SVGSVGElement>, cancel = false) {
    const d = drawing.current;
    if (!d || d.pointer !== e.pointerId) return;
    e.stopPropagation();
    drawing.current = null;
    setDraft([]);
    if (cancel || lock.current) return;
    const points = highlightPoints.parse(d.points);
    lock.current = true;
    setSaving(true);
    try {
      const { data, error } = await browserDB()
        .from("board_highlights")
        .insert({ event_id: eventId, card_id: cardId, page, color, points })
        .select("id,color,points")
        .single();
      if (error || !data) throw Error();
      setStrokes((s) => [...s, data]);
    } catch {
      onError("这笔批注未保存，请重画；原批注未改变。");
    } finally {
      lock.current = false;
      setSaving(false);
    }
  }
  const path = (points: [number, number][]) =>
    points
      .map(([x, y], i) => `${i ? "L" : "M"} ${x * 1000} ${y * 1000}`)
      .join(" ") + (points.length === 1 ? ` l 0.1 0.1` : "");
  return (
    <div className={`annotation-unit ${active ? "annotation-active" : ""}`}>
      <div className="annotation-tools" data-no-connect>
        <button
          disabled={loading || unavailable || saving}
          aria-pressed={active}
          onClick={onToggle}
        >
          {active ? "退出荧光笔" : "荧光笔"}
        </button>
        <button
          disabled={loading || saving || !strokes.length}
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
                .eq("card_id", cardId);
              if (r.error) throw Error();
              setStrokes((s) => s.filter((x) => x.id !== last.id));
            } catch {
              onError("撤销失败，请稍后重试。");
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
          className="highlight-overlay"
          data-no-connect
          viewBox="0 0 1000 1000"
          preserveAspectRatio="none"
          aria-label={active ? "荧光批注画布" : "已保存的荧光批注"}
          style={{
            pointerEvents: active && !saving && !loading ? "auto" : "none",
          }}
          onPointerDown={(e) => {
            if (e.button !== 0 || saving || loading || drawing.current) return;
            e.preventDefault();
            e.stopPropagation();
            e.currentTarget.setPointerCapture(e.pointerId);
            const p = normalizedPoint(
              e.clientX,
              e.clientY,
              e.currentTarget.getBoundingClientRect(),
            );
            drawing.current = { pointer: e.pointerId, points: [p] };
            setDraft([p]);
          }}
          onPointerMove={(e) => {
            const d = drawing.current;
            if (!d || d.pointer !== e.pointerId) return;
            e.stopPropagation();
            if (d.points.length >= 512) return;
            const point = normalizedPoint(
              e.clientX,
              e.clientY,
              e.currentTarget.getBoundingClientRect(),
            );
            d.points.push(point);
            setDraft([...d.points]);
          }}
          onPointerUp={(e) => void finish(e)}
          onPointerCancel={(e) => void finish(e, true)}
        >
          {strokes.map((s) => (
            <path
              key={s.id}
              d={path(s.points)}
              stroke={highlightColors[s.color]}
            />
          ))}
          {draft.length > 0 && (
            <path d={path(draft)} stroke={highlightColors[color]} />
          )}
        </svg>
      </div>
    </div>
  );
}
