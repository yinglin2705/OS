"use client";
import { browserDB } from "./supabase";
import { wikiEdges, type KnowledgeNode, type KnowledgeEdge } from "./knowledge";
export async function loadKnowledge() {
  const db = browserDB();
  const [events, cards, links, board, notes, noteEvents, noteLinks, noteCards] =
    await Promise.all([
      db
        .from("events")
        .select(
          "id,title,description,notes,location,course,preparation,start_at",
        )
        .is("deleted_at", null)
        .order("id")
        .limit(1000),
      db
        .from("event_board_cards")
        .select(
          "id,event_id,title,body,kind,url,image_path,original_filename,events!inner(deleted_at)",
        )
        .is("events.deleted_at", null)
        .order("id")
        .limit(1000),
      db.from("knowledge_links").select("*").order("id").limit(1000),
      db
        .from("event_board_edges")
        .select("id,from_card,to_card")
        .order("id")
        .limit(1000),
      db
        .from("notes")
        .select("id,title,course,lesson_date,body,tags")
        .is("deleted_at", null)
        .order("id")
        .limit(1000),
      db.from("note_event_links").select("note_id,event_id").limit(1000),
      db.from("note_links").select("from_note,to_note").limit(1000),
      db.from("note_card_links").select("note_id,card_id,event_id").limit(1000),
    ]);
  const results = [
    events,
    cards,
    links,
    board,
    notes,
    noteEvents,
    noteLinks,
    noteCards,
  ];
  if (results.some((r) => r.error))
    throw Error("资料无法读取，请确认已登录且资料数据库迁移已部署。");
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
    ...(notes.data || []).map((n) => ({
      id: `note:${n.id}`,
      noteId: n.id,
      title: n.title,
      body: `课程：${n.course}\n标签：${n.tags.join(", ")}\n\n${n.body}`,
      kind: "class_note",
      startAt: n.lesson_date,
    })),
  ];
  const ids = new Set(nodes.map((n) => n.id));
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
    ...(noteEvents.data || []).map((l) => ({
      id: `note-event:${l.note_id}:${l.event_id}`,
      from: `note:${l.note_id}`,
      to: `event:${l.event_id}`,
      kind: "manual" as const,
    })),
    ...(noteLinks.data || []).map((l) => ({
      id: `note-link:${l.from_note}:${l.to_note}`,
      from: `note:${l.from_note}`,
      to: `note:${l.to_note}`,
      kind: "manual" as const,
    })),
    ...(noteCards.data || []).map((l) => ({
      id: `note-card:${l.note_id}:${l.card_id}`,
      from: `note:${l.note_id}`,
      to: `card:${l.card_id}`,
      kind: "manual" as const,
    })),
    ...wikiEdges(nodes),
  ].filter((e) => ids.has(e.from) && ids.has(e.to));
  return {
    nodes,
    edges,
    truncated: results.some((r) => (r.data?.length || 0) >= 1000),
  };
}
export async function deleteKnowledgeEdge(edge: KnowledgeEdge) {
  const [kind, a, b] = edge.id.split(":");
  const db = browserDB();
  let r;
  if (kind === "note-event")
    r = await db
      .from("note_event_links")
      .delete()
      .eq("note_id", a)
      .eq("event_id", b);
  else if (kind === "note-link")
    r = await db
      .from("note_links")
      .delete()
      .eq("from_note", a)
      .eq("to_note", b);
  else if (kind === "note-card")
    r = await db
      .from("note_card_links")
      .delete()
      .eq("note_id", a)
      .eq("card_id", b);
  else r = await db.from("knowledge_links").delete().eq("id", edge.id);
  if (r.error) throw Error("移除关联失败。");
}
