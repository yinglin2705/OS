"use client";
import { browserDB } from "./supabase";
import { wikiEdges, type KnowledgeNode, type KnowledgeEdge } from "./knowledge";
export async function loadKnowledge() {
  const db = browserDB();
  const [events, cards, links, board] = await Promise.all([
    db
      .from("events")
      .select("id,title,description,notes,location,course,preparation,start_at")
      .order("id")
      .limit(1000),
    db
      .from("event_board_cards")
      .select("id,event_id,title,body,kind,url,image_path,original_filename")
      .order("id")
      .limit(1000),
    db.from("knowledge_links").select("*").order("id").limit(1000),
    db
      .from("event_board_edges")
      .select("id,from_card,to_card")
      .order("id")
      .limit(1000),
  ]);
  if ([events, cards, links, board].some((r) => r.error))
    throw Error("资料无法读取，请确认已登录且搜索迁移已部署。");
  const nodes: KnowledgeNode[] = [
    ...(events.data || []).map((e) => ({
      id: `event:${e.id}`,
      eventId: e.id,
      title: e.title,
      body: [e.description, e.notes, e.course, e.preparation]
        .filter(Boolean)
        .join("\n\n"),
      kind: "event",
      startAt: e.start_at,
      location: e.location,
    })),
    ...(cards.data || []).map((c) => ({
      id: `card:${c.id}`,
      eventId: c.event_id,
      cardId: c.id,
      title: c.title || c.original_filename || "未命名便签",
      body: c.body,
      kind: c.kind,
      url: c.url,
      filePath: c.image_path,
      filename: c.original_filename,
    })),
  ];
  const edges: KnowledgeEdge[] = [
    ...(cards.data || []).map((c) => ({
      id: `belongs:${c.id}`,
      from: `event:${c.event_id}`,
      to: `card:${c.id}`,
      kind: "event" as const,
    })),
    ...(links.data || []).map((l) => ({
      id: l.id,
      from: l.from_card ? `card:${l.from_card}` : `event:${l.from_event}`,
      to: l.to_card ? `card:${l.to_card}` : `event:${l.to_event}`,
      kind: "manual" as const,
    })),
    ...(board.data || []).map((e) => ({
      id: e.id,
      from: `card:${e.from_card}`,
      to: `card:${e.to_card}`,
      kind: "board" as const,
    })),
    ...wikiEdges(nodes),
  ];
  return {
    nodes,
    edges,
    truncated:
      (events.data?.length || 0) >= 1000 ||
      (cards.data?.length || 0) >= 1000 ||
      (links.data?.length || 0) >= 1000 ||
      (board.data?.length || 0) >= 1000,
  };
}
