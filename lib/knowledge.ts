export type KnowledgeNode = {
  id: string;
  eventId: string;
  cardId?: string;
  title: string;
  body: string;
  kind: string;
  url?: string | null;
  startAt?: string | null;
  location?: string | null;
  filePath?: string | null;
  filename?: string | null;
};
export type KnowledgeEdge = {
  id: string;
  from: string;
  to: string;
  kind: "event" | "manual" | "wiki" | "board";
};
export const zoomValue = (n: number) =>
  Math.max(0.3, Math.min(2, Math.round(n * 100) / 100));
export function dragPosition(
  origin: { x: number; y: number },
  delta: { x: number; y: number },
  zoom: number,
  limit = 1700,
) {
  return {
    x: Math.max(0, Math.min(limit, Math.round(origin.x + delta.x / zoom))),
    y: Math.max(0, Math.min(limit, Math.round(origin.y + delta.y / zoom))),
  };
}
export function references(body: string): string[] {
  return [
    ...new Set(
      [...body.matchAll(/\[\[([^\]\n]+)\]\]/g)]
        .map((m) => m[1].split("|")[0].trim())
        .filter(Boolean),
    ),
  ];
}
export function wikiEdges(nodes: KnowledgeNode[]): KnowledgeEdge[] {
  const index = new Map<string, KnowledgeNode[]>();
  for (const n of nodes) {
    for (const key of new Set([n.id, n.title.trim(), n.id.replace(":", "-")])) {
      const k = key.toLocaleLowerCase();
      index.set(k, [...(index.get(k) || []), n]);
    }
  }
  const edges: KnowledgeEdge[] = [];
  for (const n of nodes)
    for (const ref of references(n.body)) {
      const matches = index.get(ref.toLocaleLowerCase());
      if (matches?.length === 1 && matches[0].id !== n.id)
        edges.push({
          id: `wiki:${n.id}:${matches[0].id}`,
          from: n.id,
          to: matches[0].id,
          kind: "wiki",
        });
    }
  return edges;
}
export function neighborhood(
  results: Set<string>,
  nodes: KnowledgeNode[],
  edges: KnowledgeEdge[],
) {
  const ids = new Set(results);
  for (const e of edges)
    if (results.has(e.from) || results.has(e.to)) {
      ids.add(e.from);
      ids.add(e.to);
    }
  return {
    nodes: nodes.filter((n) => ids.has(n.id)),
    edges: edges.filter((e) => ids.has(e.from) && ids.has(e.to)),
  };
}
export const markdownFilename = (node: KnowledgeNode) =>
  node.id.replace(":", "-") + ".md";
export function nodeMarkdown(
  node: KnowledgeNode,
  nodes: KnowledgeNode[],
  edges: KnowledgeEdge[],
  attachment?: string,
) {
  const title = node.title.replace(/[\r\n]/g, " ");
  const outgoing = edges
    .filter((e) => e.from === node.id || e.to === node.id)
    .map((e) => (e.from === node.id ? e.to : e.from));
  const related = [...new Set(outgoing)]
    .map((id) => nodes.find((n) => n.id === id))
    .filter((n): n is KnowledgeNode => !!n);
  const safeURL = node.url && /^https?:\/\//i.test(node.url) ? node.url : null;
  const escaped = (s: string) => s.replace(/[\[\]|\r\n]/g, " ");
  const labels = new Map<string, KnowledgeNode[]>();
  for (const n of nodes) {
    const key = n.title.trim().toLocaleLowerCase();
    labels.set(key, [...(labels.get(key) || []), n]);
  }
  const body = node.body.replace(
    /\[\[([^\]\n]+)\]\]/g,
    (original, ref: string) => {
      const [target, alias] = ref.split("|");
      const candidates = nodes.filter(
        (n) =>
          n.id === target.trim() || n.id.replace(":", "-") === target.trim(),
      );
      const matches = candidates.length
        ? candidates
        : labels.get(target.trim().toLocaleLowerCase());
      return matches?.length === 1
        ? `[[${markdownFilename(matches[0]).slice(0, -3)}|${escaped(alias || matches[0].title)}]]`
        : original;
    },
  );
  return `---\nying_id: ${JSON.stringify(node.id)}\nkind: ${JSON.stringify(node.kind)}\n---\n\n# ${title}\n\n${node.startAt ? `时间：${node.startAt}\n\n` : ""}${node.location ? `地点：${node.location}\n\n` : ""}${body}\n\n${safeURL ? `来源：<${safeURL}>\n\n` : ""}${attachment ? `${node.kind === "image" ? "!" : ""}[[${attachment}]]\n\n` : node.filePath ? "附件未包含在此次导出；请回到 YING OS 访问。\n\n" : ""}${related.length ? "## 关联\n\n" + related.map((n) => `- [[${markdownFilename(n).slice(0, -3)}|${escaped(n.title)}]]`).join("\n") : ""}\n`;
}

export function nextCardPosition(
  cards: { x: number; y: number }[],
  ideal: { x: number; y: number },
) {
  const candidates = [ideal];
  for (let y = 40; y <= 1660; y += 540)
    for (let x = 40; x <= 1590; x += 310) candidates.push({ x, y });
  candidates.sort(
    (a, b) =>
      (a.x - ideal.x) ** 2 +
      (a.y - ideal.y) ** 2 -
      ((b.x - ideal.x) ** 2 + (b.y - ideal.y) ** 2),
  );
  return (
    candidates.find((p) =>
      cards.every(
        (c) =>
          p.x + 290 <= c.x ||
          c.x + 290 <= p.x ||
          p.y + 500 <= c.y ||
          c.y + 500 <= p.y,
      ),
    ) || ideal
  );
}
