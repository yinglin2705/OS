"use client";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { browserDB, configured } from "@/lib/supabase";
import { references } from "@/lib/knowledge";
import NotesImporter from "./NotesImporter";
type Note = {
  id: string;
  title: string;
  course: string;
  lesson_date: string | null;
  body: string;
  tags: string[];
  version: number;
  updated_at: string;
};
type Event = {
  id: string;
  title: string;
  start_at: string | null;
  course: string | null;
};
type Source = {
  id: string;
  source_type: string;
  original_text: string;
  source_label: string | null;
  batch_id: string | null;
};
type Revision = {
  id: string;
  created_at: string;
  old_record: unknown;
  new_record: unknown;
};
export default function NotesWorkspace() {
  const [notes, setNotes] = useState<Note[]>([]),
    [events, setEvents] = useState<Event[]>([]),
    [links, setLinks] = useState<{ note_id: string; event_id: string }[]>([]),
    [noteLinks, setNoteLinks] = useState<
      { from_note: string; to_note: string }[]
    >([]);
  const [user, setUser] = useState(false),
    [message, setMessage] = useState("正在读取…"),
    [busy, setBusy] = useState(false),
    [course, setCourse] = useState("all"),
    [query, setQuery] = useState(""),
    [eventFilter, setEventFilter] = useState("");
  const [selected, setSelected] = useState<Note | null>(null),
    [draft, setDraft] = useState({
      title: "",
      course: "未分类",
      lesson_date: "",
      body: "",
      tags: "",
    }),
    [editing, setEditing] = useState(false),
    [dirty, setDirty] = useState(false),
    [preview, setPreview] = useState(false),
    [importer, setImporter] = useState(false),
    [sources, setSources] = useState<Source[]>([]),
    [revisions, setRevisions] = useState<Revision[]>([]),
    [eventChoice, setEventChoice] = useState("");
  const lock = useRef(false),
    initialized = useRef(false);
  async function load() {
    const db = browserDB();
    const [n, e, l, nl] = await Promise.all([
      db
        .from("notes")
        .select("*")
        .is("deleted_at", null)
        .order("lesson_date", { ascending: false, nullsFirst: false })
        .order("updated_at", { ascending: false })
        .limit(1000),
      db
        .from("events")
        .select("id,title,start_at,course")
        .is("deleted_at", null)
        .order("start_at")
        .limit(1000),
      db.from("note_event_links").select("note_id,event_id").limit(2000),
      db.from("note_links").select("from_note,to_note").limit(2000),
    ]);
    if ([n, e, l, nl].some((r) => r.error))
      throw Error("笔记无法读取，请确认笔记数据库迁移已完成。");
    setNotes(n.data || []);
    setEvents(e.data || []);
    setLinks(l.data || []);
    setNoteLinks(nl.data || []);
    return n.data as Note[];
  }
  useEffect(() => {
    let live = true;
    (async () => {
      if (!configured()) throw Error("尚未配置数据库。");
      const {
        data: { user },
      } = await browserDB().auth.getUser();
      if (!user) throw Error("请返回日历登录。");
      if (!live) return;
      setUser(true);
      const data = await load();
      if (!initialized.current) {
        initialized.current = true;
        const url = new URL(window.location.href);
        const id = url.searchParams.get("note");
        setEventFilter(url.searchParams.get("event") || "");
        const found = data.find((n) => n.id === id);
        if (found) openNote(found, false);
      }
      setMessage("");
    })().catch((e) => {
      if (live) setMessage(e.message);
    });
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    if (!selected) {
      setSources([]);
      setRevisions([]);
      return;
    }
    let live = true;
    setSources([]);
    setRevisions([]);
    browserDB()
      .from("note_sources")
      .select("id,source_type,original_text,source_label,batch_id")
      .eq("note_id", selected.id)
      .order("created_at", { ascending: false })
      .then((r) => {
        if (live) {
          if (r.error) setMessage("来源原文读取失败。");
          else setSources(r.data || []);
        }
      });
    return () => {
      live = false;
    };
  }, [selected?.id]);
  useEffect(() => {
    const before = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", before);
    return () => window.removeEventListener("beforeunload", before);
  }, [dirty]);
  function openNote(note: Note, check = true) {
    if (
      check &&
      dirty &&
      !window.confirm("当前修改尚未保存，切换笔记会丢失草稿。继续？")
    )
      return;
    setSelected(note);
    setDraft({
      title: note.title,
      course: note.course,
      lesson_date: note.lesson_date || "",
      body: note.body,
      tags: note.tags.join(", "),
    });
    setEditing(true);
    setDirty(false);
    setPreview(true);
    window.history.replaceState(null, "", `/notes?note=${note.id}`);
  }
  function create() {
    if (dirty && !window.confirm("放弃当前未保存的修改？")) return;
    const event = events.find((e) => e.id === eventFilter);
    setSelected(null);
    setDraft({
      title: "",
      course:
        course === "all"
          ? event?.title.includes("C4D")
            ? "C4D"
            : event?.course || "未分类"
          : course,
      lesson_date: "",
      body: "## 知识点\n\n\n## 操作步骤\n\n\n## 问题\n\n\n## 待办\n\n",
      tags: "",
    });
    setEditing(true);
    setDirty(true);
    setPreview(false);
  }
  function change(key: keyof typeof draft, value: string) {
    setDraft((d) => ({ ...d, [key]: value }));
    setDirty(true);
  }
  async function save() {
    if (lock.current || !draft.title.trim()) return;
    lock.current = true;
    setBusy(true);
    try {
      const body = {
        title: draft.title.trim(),
        course: draft.course.trim() || "未分类",
        lesson_date: draft.lesson_date || null,
        body: draft.body,
        tags: draft.tags
          .split(/[,，]/)
          .map((t) => t.trim())
          .filter(Boolean),
      };
      if (body.tags.length > 20) throw Error("最多20个标签。");
      const db = browserDB();
      const r = selected
        ? await db
            .from("notes")
            .update(body)
            .eq("id", selected.id)
            .eq("version", selected.version)
            .select("*")
            .single()
        : await db.from("notes").insert(body).select("*").single();
      if (r.error || !r.data)
        throw Error("保存失败或笔记已在其他窗口变化；草稿已保留，请先核对。");
      let associationFailed = false;
      if (
        !selected &&
        eventFilter &&
        events.some((e) => e.id === eventFilter)
      ) {
        const related = await db
          .from("note_event_links")
          .insert({ note_id: r.data.id, event_id: eventFilter });
        associationFailed = !!related.error;
      }
      await load();
      openNote(r.data, false);
      setMessage(
        associationFailed
          ? "笔记已保存，但日程关联未保存，请手动重试。"
          : "笔记已保存，保留修改历史。",
      );
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "保存失败。");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  useEffect(() => {
    const hotkey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s" && editing) {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", hotkey);
    return () => window.removeEventListener("keydown", hotkey);
  }, [draft, selected, editing]);
  const filtered = notes.filter(
    (n) =>
      (course === "all" || n.course.toLowerCase() === course.toLowerCase()) &&
      (!eventFilter ||
        links.some((l) => l.note_id === n.id && l.event_id === eventFilter)) &&
      (n.title + " " + n.body + " " + n.course + " " + n.tags.join(" "))
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const courses = [
    ...new Map(notes.map((n) => [n.course.toLowerCase(), n.course])).values(),
  ];
  const mentioned = useMemo(
    () =>
      selected
        ? notes.filter(
            (n) =>
              n.id !== selected.id &&
              references(selected.body).some(
                (r) =>
                  r === `note-${n.id}` ||
                  r === `note:${n.id}` ||
                  (r.toLowerCase() === n.title.toLowerCase() &&
                    notes.filter(
                      (o) => o.title.toLowerCase() === r.toLowerCase(),
                    ).length === 1),
              ),
          )
        : [],
    [notes, selected],
  );
  const backlinks = selected
    ? notes.filter(
        (n) =>
          n.id !== selected.id &&
          (references(n.body).some(
            (r) =>
              r === `note-${selected.id}` ||
              r === `note:${selected.id}` ||
              (r.toLowerCase() === selected.title.toLowerCase() &&
                notes.filter((o) => o.title.toLowerCase() === r.toLowerCase())
                  .length === 1),
          ) ||
            noteLinks.some(
              (l) => l.from_note === n.id && l.to_note === selected.id,
            )),
      )
    : [];
  function inline(text: string): ReactNode[] {
    const parts: ReactNode[] = [];
    let last = 0;
    for (const m of text.matchAll(/\[\[([^\]\n]+)\]\]/g)) {
      parts.push(text.slice(last, m.index));
      const [target, alias] = m[1].split("|");
      const matches = notes.filter(
        (n) =>
          `note-${n.id}` === target.trim() ||
          `note:${n.id}` === target.trim() ||
          n.title.toLowerCase() === target.trim().toLowerCase(),
      );
      parts.push(
        matches.length === 1 ? (
          <a
            key={`${m.index}-${target}`}
            href={`/notes?note=${matches[0].id}`}
            onClick={(e) => {
              e.preventDefault();
              openNote(matches[0]);
            }}
          >
            {alias || matches[0].title}
          </a>
        ) : (
          <span
            className="muted"
            key={`${m.index}-${target}`}
            title="未找到或标题重名，请使用唯一标题或note-ID"
          >
            {m[0]}
          </span>
        ),
      );
      last = (m.index || 0) + m[0].length;
    }
    parts.push(text.slice(last));
    return parts;
  }
  const linkedEvents = selected
    ? events.filter((e) =>
        links.some((l) => l.note_id === selected.id && l.event_id === e.id),
      )
    : [];
  return (
    <main className="notes-page">
      <Link href="/">← 日历</Link>
      <header className="knowledge-heading">
        <div>
          <p className="eyebrow">课程 · 课次 · 相互连接</p>
          <h1>笔记</h1>
        </div>
        <div className="actions">
          <Link href="/search">全局搜索与关联</Link>
          <Link href="/trash">回收站</Link>
          <button
            disabled={!user || busy}
            onClick={() => setImporter(!importer)}
          >
            {importer ? "收起导入" : "导入聊天 / 课堂笔记"}
          </button>
          <button className="primary" disabled={!user || busy} onClick={create}>
            ＋ 独立笔记
          </button>
        </div>
      </header>
      <p role="status" aria-live="polite">
        {message}
      </p>
      {importer && (
        <NotesImporter
          events={events}
          course={course}
          onSaved={async () => {
            await load();
          }}
          onMessage={setMessage}
        />
      )}
      {user && (
        <div className="notes-layout">
          <aside className="panel notes-library">
            <label>
              课程
              <select
                value={course}
                onChange={(e) => setCourse(e.target.value)}
              >
                <option value="all">所有课程</option>
                {courses.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            <input
              type="search"
              aria-label="搜索独立笔记"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜C4D、知识点或标签…"
            />
            {eventFilter && (
              <p className="notice">
                仅看对应日程的笔记
                <button onClick={() => setEventFilter("")}>显示全部</button>
              </p>
            )}
            <p className="muted">{filtered.length}篇独立笔记</p>
            {filtered.map((n) => (
              <button
                key={n.id}
                className={`notes-list-item ${selected?.id === n.id ? "selected" : ""}`}
                onClick={() => openNote(n)}
              >
                <strong>{n.title}</strong>
                <small>
                  {n.course} · {n.lesson_date || "日期待确认"}
                </small>
              </button>
            ))}
            {!filtered.length && (
              <p className="muted">还没有匹配的笔记。可新建或导入课堂记录。</p>
            )}
          </aside>
          <section className="notes-editor">
            {editing ? (
              <>
                <div className="notes-editor-toolbar">
                  <button
                    className="primary"
                    disabled={busy || !draft.title.trim() || !dirty}
                    onClick={() => void save()}
                  >
                    保存笔记
                  </button>
                  <button onClick={() => setPreview(!preview)}>
                    {preview ? "编辑正文" : "预览链接"}
                  </button>
                  <span className="muted">
                    {dirty ? "有未保存修改 · Ctrl/⌘+S保存" : "已保存"}
                  </span>
                  {selected && (
                    <button
                      disabled={busy}
                      onClick={async () => {
                        if (
                          !window.confirm(
                            "将笔记移入回收站？日程和其他笔记保留，可恢复。",
                          )
                        )
                          return;
                        const r = await browserDB().rpc("trash_note", {
                          target: selected.id,
                          restore: false,
                        });
                        if (r.error) {
                          setMessage("删除失败");
                          return;
                        }
                        setSelected(null);
                        setEditing(false);
                        setDirty(false);
                        await load();
                        setMessage("笔记已移入回收站。");
                      }}
                    >
                      移入回收站
                    </button>
                  )}
                </div>
                <div className="notes-metadata">
                  <label>
                    标题
                    <input
                      maxLength={200}
                      value={draft.title}
                      onChange={(e) => change("title", e.target.value)}
                    />
                  </label>
                  <label>
                    课程
                    <input
                      maxLength={200}
                      value={draft.course}
                      onChange={(e) => change("course", e.target.value)}
                      placeholder="C4D"
                    />
                  </label>
                  <label>
                    课次日期
                    <input
                      type="date"
                      value={draft.lesson_date}
                      onChange={(e) => change("lesson_date", e.target.value)}
                    />
                  </label>
                  <label>
                    标签（逗号分隔）
                    <input
                      value={draft.tags}
                      onChange={(e) => change("tags", e.target.value)}
                    />
                  </label>
                </div>
                {preview ? (
                  <article className="panel notes-markdown">
                    {draft.body
                      .split("\n")
                      .map((line, i) =>
                        line.startsWith("## ") ? (
                          <h3 key={i}>{inline(line.slice(3))}</h3>
                        ) : line.startsWith("# ") ? (
                          <h2 key={i}>{inline(line.slice(2))}</h2>
                        ) : (
                          <p key={i}>{inline(line)}</p>
                        ),
                      )}
                  </article>
                ) : (
                  <textarea
                    className="notes-body-editor"
                    aria-label="独立笔记正文"
                    maxLength={100000}
                    value={draft.body}
                    onChange={(e) => change("body", e.target.value)}
                    placeholder="写笔记，用 [[另一篇笔记标题]] 建立内部链接"
                  />
                )}
                {selected && (
                  <>
                    <section className="panel">
                      <h3>关联日程</h3>
                      {linkedEvents.map((e) => (
                        <p key={e.id}>
                          <a href={`/?event=${e.id}`}>{e.title} ↗ 日历</a>{" "}
                          <button
                            onClick={async () => {
                              const r = await browserDB()
                                .from("note_event_links")
                                .delete()
                                .eq("note_id", selected.id)
                                .eq("event_id", e.id);
                              if (r.error) setMessage("移除关联失败");
                              else await load();
                            }}
                          >
                            移除关联
                          </button>
                        </p>
                      ))}
                      <div className="actions">
                        <select
                          aria-label="关联一个日程"
                          value={eventChoice}
                          onChange={(e) => setEventChoice(e.target.value)}
                        >
                          <option value="">选择日程</option>
                          {events
                            .filter(
                              (e) => !linkedEvents.some((l) => l.id === e.id),
                            )
                            .map((e) => (
                              <option key={e.id} value={e.id}>
                                {e.title}
                                {e.start_at
                                  ? " · " + e.start_at.slice(0, 10)
                                  : ""}
                              </option>
                            ))}
                        </select>
                        <button
                          disabled={!eventChoice}
                          onClick={async () => {
                            const r = await browserDB()
                              .from("note_event_links")
                              .insert({
                                note_id: selected.id,
                                event_id: eventChoice,
                              });
                            if (r.error) setMessage("关联失败或已存在");
                            else {
                              setEventChoice("");
                              await load();
                            }
                          }}
                        >
                          关联
                        </button>
                      </div>
                    </section>
                    <section className="panel">
                      <h3>笔记连接</h3>
                      <p>
                        引用了：
                        {mentioned.length
                          ? mentioned.map((n) => (
                              <button key={n.id} onClick={() => openNote(n)}>
                                {n.title}
                              </button>
                            ))
                          : "暂无"}
                      </p>
                      <p>
                        被引用：
                        {backlinks.length
                          ? backlinks.map((n) => (
                              <button key={n.id} onClick={() => openNote(n)}>
                                {n.title}
                              </button>
                            ))
                          : "暂无"}
                      </p>
                      <small className="muted">
                        同名笔记不会猜测连接；可使用 [[note-{selected.id}]]
                        精确引用。
                      </small>
                    </section>
                    <section className="panel">
                      <h3>原文与来源</h3>
                      {sources.map((s) => (
                        <details key={s.id}>
                          <summary>
                            {s.source_label || s.source_type} ·{" "}
                            {s.source_type.includes("unverified")
                              ? "待核实"
                              : "来源"}
                          </summary>
                          <pre className="notes-source">{s.original_text}</pre>
                          <button
                            onClick={async () => {
                              if (
                                !window.confirm(
                                  "永久删除这条笔记来源？导入批次内的完整聊天仍保留，可到导入记录单独删除。",
                                )
                              )
                                return;
                              const r = await browserDB().rpc(
                                "delete_note_record",
                                { record_type: "source", target: s.id },
                              );
                              if (r.error) setMessage("删除来源失败");
                              else
                                setSources((all) =>
                                  all.filter((x) => x.id !== s.id),
                                );
                            }}
                          >
                            删除这条来源
                          </button>
                        </details>
                      ))}
                      {!sources.length && (
                        <p className="muted">
                          手动笔记或未附原文，可从修改历史核对保存内容。
                        </p>
                      )}
                    </section>
                    <details className="panel">
                      <summary>修改历史</summary>
                      <button
                        onClick={async () => {
                          const r = await browserDB()
                            .from("note_revisions")
                            .select("id,created_at,old_record,new_record")
                            .eq("note_id", selected.id)
                            .order("created_at", { ascending: false })
                            .limit(20);
                          if (r.error) setMessage("历史读取失败");
                          else setRevisions(r.data || []);
                        }}
                      >
                        读取最近20个版本
                      </button>
                      {revisions.map((r) => (
                        <details key={r.id}>
                          <summary>{r.created_at}</summary>
                          <pre className="notes-source">
                            {JSON.stringify(r.new_record, null, 2)}
                          </pre>
                          <button
                            onClick={async () => {
                              if (
                                !window.confirm(
                                  "永久删除这条修改快照？当前笔记不变。",
                                )
                              )
                                return;
                              const d = await browserDB().rpc(
                                "delete_note_record",
                                { record_type: "revision", target: r.id },
                              );
                              if (d.error) setMessage("删除失败");
                              else
                                setRevisions((v) =>
                                  v.filter((x) => x.id !== r.id),
                                );
                            }}
                          >
                            删除快照
                          </button>
                        </details>
                      ))}
                    </details>
                  </>
                )}
              </>
            ) : (
              <div className="panel">
                <h2>每一课，一篇独立笔记</h2>
                <p>
                  左侧按课程查找，或导入课堂聊天。笔记可独立存在，也可双向关联日程。
                </p>
              </div>
            )}
          </section>
        </div>
      )}
    </main>
  );
}
