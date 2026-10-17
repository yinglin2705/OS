import { describe, it, expect } from "vitest";
import {
  dragPosition,
  zoomValue,
  nextCardPosition,
  wikiEdges,
  neighborhood,
  nodeMarkdown,
  type KnowledgeNode,
} from "../lib/knowledge";
const a: KnowledgeNode = {
  id: "event:a",
  eventId: "a",
  title: "设计课程",
  body: "参考 [[研究笔记]]",
  kind: "event",
};
const b: KnowledgeNode = {
  id: "card:b",
  eventId: "a",
  cardId: "b",
  title: "研究笔记",
  body: "原始文字",
  kind: "note",
};
describe("knowledge workspace", () => {
  it("keeps dragging in world coordinates at different zooms and clamps bounds", () => {
    expect(dragPosition({ x: 100, y: 100 }, { x: 50, y: -100 }, 0.5)).toEqual({
      x: 200,
      y: 0,
    });
    expect(dragPosition({ x: 1600, y: 1600 }, { x: 400, y: 400 }, 2)).toEqual({
      x: 1700,
      y: 1700,
    });
    expect(zoomValue(0.01)).toBe(0.3);
    expect(zoomValue(5)).toBe(2);
  });
  it("places new cards away from existing material when room is available", () => {
    const position = nextCardPosition([{ x: 40, y: 40 }], { x: 80, y: 80 });
    expect(position.x >= 330 || position.y >= 540).toBe(true);
  });
  it("resolves unique wiki references, respects aliases and avoids ambiguous titles", () => {
    expect(wikiEdges([a, b])).toEqual([
      {
        id: "wiki:event:a:card:b",
        from: "event:a",
        to: "card:b",
        kind: "wiki",
      },
    ]);
    expect(wikiEdges([a, b, { ...b, id: "card:c" }])).toHaveLength(0);
    expect(wikiEdges([{ ...a, body: "[[card-b|reference]]" }, b])).toHaveLength(
      1,
    );
  });
  it("shows one hop from hits without unrelated private graph clutter", () => {
    const c = { ...b, id: "card:c" },
      d = { ...b, id: "card:d" };
    const edges = [
      { id: "1", from: a.id, to: b.id, kind: "manual" as const },
      { id: "2", from: b.id, to: c.id, kind: "manual" as const },
    ];
    const graph = neighborhood(new Set([a.id]), [a, b, c, d], edges);
    expect(graph.nodes.map((n) => n.id)).toEqual([a.id, b.id]);
    expect(graph.edges).toHaveLength(1);
  });
  it("exports stable Obsidian links, attachments and reverse connections without signed URLs", () => {
    const edges = wikiEdges([a, b]);
    const md = nodeMarkdown(a, [a, b], edges);
    expect(md).toContain("[[card-b|研究笔记]]");
    expect(nodeMarkdown(b, [a, b], edges)).toContain("[[event-a|设计课程]]");
    expect(
      nodeMarkdown(
        { ...b, kind: "image", filePath: "private.png" },
        [b],
        [],
        "attachments/card-b.png",
      ),
    ).toContain("![[attachments/card-b.png]]");
    expect(
      nodeMarkdown({ ...b, url: "javascript:alert(1)" }, [b], []),
    ).not.toContain("javascript:");
    expect(nodeMarkdown({ ...b, filePath: "private.pdf" }, [b], [])).toContain(
      "附件未包含",
    );
  });
});
