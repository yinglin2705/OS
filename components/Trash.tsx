"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { browserDB, configured } from "@/lib/supabase";
import { cleanupFiles } from "@/lib/deletion-client";
type Trashed = { id: string; title: string; deleted_at: string };
export default function Trash() {
  const [events, setEvents] = useState<Trashed[]>([]),
    [notes, setNotes] = useState<Trashed[]>([]),
    [jobs, setJobs] = useState(0),
    [message, setMessage] = useState("正在读取…"),
    [busy, setBusy] = useState(false);
  async function load() {
    const db = browserDB();
    const [e, n, j] = await Promise.all([
      db
        .from("events")
        .select("id,title,deleted_at")
        .not("deleted_at", "is", null)
        .order("deleted_at", { ascending: false }),
      db
        .from("notes")
        .select("id,title,deleted_at")
        .not("deleted_at", "is", null)
        .order("deleted_at", { ascending: false }),
      db
        .from("file_deletion_jobs")
        .select("id", { head: true, count: "exact" }),
    ]);
    if (e.error || n.error || j.error)
      throw Error("回收站无法读取，请先登录或确认数据库更新。");
    setEvents(e.data || []);
    setNotes(n.data || []);
    setJobs(j.count || 0);
  }
  useEffect(() => {
    if (!configured()) {
      setMessage("尚未配置数据库");
      return;
    }
    load()
      .then(() => setMessage(""))
      .catch((e) => setMessage(e.message));
  }, []);
  async function restore(kind: "event" | "note", id: string) {
    setBusy(true);
    try {
      const r = await browserDB().rpc(
        kind === "event" ? "trash_event" : "trash_note",
        { target: id, restore: true },
      );
      if (r.error) throw Error("恢复失败");
      await load();
      setMessage(
        kind === "event"
          ? "日程已恢复；重新生成的准备提醒仍需批准。"
          : "笔记已恢复。",
      );
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "恢复失败");
    } finally {
      setBusy(false);
    }
  }
  async function purge(kind: "event" | "note", record: Trashed) {
    if (
      !window.confirm(
        `永久删除「${record.title}」？此操作无法恢复。${kind === "event" ? "关联看板、附件、提醒与日程来源将删除；独立课程笔记保留。" : "笔记原文来源、版本和连接将删除；日程不受影响。"}历史导入批次中的原文可到管理页另行删除。`,
      )
    )
      return;
    setBusy(true);
    try {
      const r =
        kind === "event"
          ? await browserDB().rpc("purge_event", { target: record.id })
          : await browserDB().rpc("delete_note_record", {
              record_type: "note",
              target: record.id,
            });
      if (r.error) throw Error("删除失败，可能仍有提醒正在发送，请稍后检查。");
      const failed = await cleanupFiles();
      await load();
      setMessage(
        failed
          ? "记录已删除，部分附件待清理，可重试。"
          : "记录与已排队附件已永久清理。",
      );
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "删除失败");
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="knowledge-page">
      <Link href="/">← 日历</Link>
      <header className="knowledge-heading">
        <h1>回收站</h1>
        <Link href="/manage">管理与删除其他记录</Link>
      </header>
      <p className="muted">
        删除先移到这里，可恢复。永久删除必须单独确认；没有自动清空期限。
      </p>
      <p role="status">{message}</p>
      {(["event", "note"] as const).map((kind) => (
        <section className="panel" key={kind}>
          <h2>{kind === "event" ? "日程" : "独立笔记"}</h2>
          {(kind === "event" ? events : notes).map((record) => (
            <div className="trash-row" key={record.id}>
              <div>
                <strong>{record.title}</strong>
                <small>{record.deleted_at}</small>
              </div>
              <button
                disabled={busy}
                onClick={() => void restore(kind, record.id)}
              >
                恢复
              </button>
              <button disabled={busy} onClick={() => void purge(kind, record)}>
                永久删除
              </button>
            </div>
          ))}
          {!(kind === "event" ? events : notes).length && (
            <p className="muted">暂无</p>
          )}
        </section>
      ))}
      <section className="panel">
        <h2>待清理附件 · {jobs}</h2>
        <p className="muted">
          只清理你已永久删除的资料文件，不清理仍在回收站的附件。
        </p>
        <button
          disabled={busy || !jobs}
          onClick={async () => {
            setBusy(true);
            try {
              const failed = await cleanupFiles();
              await load();
              setMessage(
                failed
                  ? "仍有部分文件未清理，请检查网络或存储配置。"
                  : "本轮附件清理完成。",
              );
            } catch (e) {
              setMessage(e instanceof Error ? e.message : "清理失败");
            } finally {
              setBusy(false);
            }
          }}
        >
          重试附件清理
        </button>
      </section>
    </main>
  );
}
