import { z } from "zod";
export const highlightColors = {
  yellow: "#ffe54d",
  pink: "#ff87b6",
  green: "#82df91",
  blue: "#7bcaff",
} as const;
export type HighlightColor = keyof typeof highlightColors;
export const highlightPoints = z
  .array(z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]))
  .min(1)
  .max(512);
export function normalizedPoint(
  x: number,
  y: number,
  rect: { left: number; top: number; width: number; height: number },
): [number, number] {
  return [
    Math.max(0, Math.min(1, (x - rect.left) / Math.max(1, rect.width))),
    Math.max(0, Math.min(1, (y - rect.top) / Math.max(1, rect.height))),
  ];
}
export function resizedWidth(
  initial: number,
  screenDelta: number,
  zoom: number,
  kind: string,
) {
  return Math.max(
    kind === "pdf" ? 400 : 200,
    Math.min(
      kind === "pdf" ? 1000 : 900,
      Math.round(initial + screenDelta / zoom),
    ),
  );
}
export function cardWidth(card: { kind: string; display_width?: number }) {
  return (
    card.display_width ||
    (card.kind === "pdf" ? 540 : card.kind === "image" ? 340 : 270)
  );
}
export function edgeAnchors(
  a: { x: number; y: number; kind: string; display_width?: number },
  b: { x: number; y: number; kind: string; display_width?: number },
) {
  const aw = cardWidth(a),
    bw = cardWidth(b);
  if (a.x + aw > b.x && b.x + bw > a.x)
    return {
      start: { x: a.x + aw / 2, y: a.y },
      end: { x: b.x + bw / 2, y: b.y },
    };
  const right = b.x + bw / 2 >= a.x + aw / 2;
  return {
    start: { x: a.x + (right ? aw : 0), y: a.y + 50 },
    end: { x: b.x + (right ? 0 : bw), y: b.y + 50 },
  };
}
export const LONG_PRESS_MS = 450;

export type AnnotationTool = "pen" | "eraser";
type Point = [number, number];
function pointSegmentDistance(p: Point, a: Point, b: Point) {
  const dx = b[0] - a[0],
    dy = b[1] - a[1],
    length = dx * dx + dy * dy;
  const t = length
    ? Math.max(
        0,
        Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length),
      )
    : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
function segmentDistance(a: Point, b: Point, c: Point, d: Point) {
  const cross = (p: Point, q: Point, r: Point) =>
    (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  if (
    cross(a, b, c) * cross(a, b, d) < 0 &&
    cross(c, d, a) * cross(c, d, b) < 0
  )
    return 0;
  return Math.min(
    pointSegmentDistance(a, c, d),
    pointSegmentDistance(b, c, d),
    pointSegmentDistance(c, a, b),
    pointSegmentDistance(d, a, b),
  );
}
/** Screen-space swept eraser: handles fast crossings and changing board zoom. */
export function erasedStrokeIds(
  strokes: { id: string; points: Point[] }[],
  trail: Point[],
  rect: { width: number; height: number },
  radius = 10,
): string[] {
  if (!trail.length) return [];
  const pixel = (p: Point): Point => [p[0] * rect.width, p[1] * rect.height];
  const swept = trail.map(pixel);
  const tolerance = radius + Math.max(rect.width, rect.height) * 0.014;
  return strokes
    .filter((stroke) => {
      const points = stroke.points.map(pixel);
      for (let i = 0; i < Math.max(1, swept.length - 1); i++)
        for (let j = 0; j < Math.max(1, points.length - 1); j++) {
          if (!points.length) continue;
          if (
            segmentDistance(
              swept[i],
              swept[Math.min(i + 1, swept.length - 1)],
              points[j],
              points[Math.min(j + 1, points.length - 1)],
            ) <= tolerance
          )
            return true;
        }
      return false;
    })
    .map((s) => s.id);
}
