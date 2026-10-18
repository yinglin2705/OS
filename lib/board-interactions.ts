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
