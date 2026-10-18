import { describe, it, expect } from "vitest";
import {
  normalizedPoint,
  resizedWidth,
  cardWidth,
  edgeAnchors,
  highlightPoints,
} from "../lib/board-interactions";
describe("direct board manipulation", () => {
  it("anchors highlights relative to the artifact at different board zooms", () => {
    expect(
      normalizedPoint(150, 100, {
        left: 100,
        top: 50,
        width: 100,
        height: 100,
      }),
    ).toEqual([0.5, 0.5]);
    expect(
      normalizedPoint(200, 150, {
        left: 100,
        top: 50,
        width: 200,
        height: 200,
      }),
    ).toEqual([0.5, 0.5]);
    expect(
      normalizedPoint(-50, 1000, { left: 0, top: 0, width: 100, height: 100 }),
    ).toEqual([0, 1]);
  });
  it("resizes in world coordinates, differentiates document and note sizes, and caps canvas work", () => {
    expect(resizedWidth(340, 60, 0.5, "image")).toBe(460);
    expect(resizedWidth(540, -1000, 1, "pdf")).toBe(400);
    expect(resizedWidth(540, 5000, 1, "pdf")).toBe(1000);
    expect(cardWidth({ kind: "pdf" })).toBeGreaterThan(
      cardWidth({ kind: "note" }),
    );
  });
  it("keeps connector endpoints outside card interiors in both directions", () => {
    const a = { x: 40, y: 70, kind: "note" },
      b = { x: 600, y: 100, kind: "pdf" };
    expect(edgeAnchors(a, b)).toEqual({
      start: { x: 310, y: 120 },
      end: { x: 600, y: 150 },
    });
    expect(edgeAnchors(b, a)).toEqual({
      start: { x: 600, y: 150 },
      end: { x: 310, y: 120 },
    });
  });
  it("routes above horizontally overlapping cards rather than hiding endpoints inside them", () => {
    const anchors = edgeAnchors(
      { x: 140, y: 130, kind: "note" },
      { x: 390, y: 100, kind: "image", display_width: 440 },
    );
    expect(anchors.start).toEqual({ x: 275, y: 130 });
    expect(anchors.end).toEqual({ x: 610, y: 100 });
  });
  it("rejects malformed, oversized and non-normalized annotation payloads", () => {
    expect(
      highlightPoints.safeParse([
        [0, 0],
        [1, 1],
      ]).success,
    ).toBe(true);
    for (const p of [
      [],
      [[2, 0.5]],
      [[NaN, 0]],
      Array.from({ length: 513 }, () => [0.1, 0.1]),
      [["script", 0]],
    ])
      expect(highlightPoints.safeParse(p).success).toBe(false);
  });
});
