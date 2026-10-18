"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { browserDB, configured } from "@/lib/supabase";
import { deleteOwned } from "@/lib/deletion-client";
const types = {
  proposal: {
    label: "日程导入提议",
    table: "change_proposals",
    select: "id,payload,created_at",
  },
  batch: {
    label: "日程导入批次",
    table: "ingestion_batches",
    select: "id,filename,created_at",
  },
  source: {
    label: "日程来源",
    table: "event_sources",
    select: "id,notes,url,created_at",
  },
  history: {
    label: "日程修改历史",
    table: "event_status_history",
    select: "id,new_record,created_at",
  },
  task: {
    label: "准备任务",
    table: "preparation_tasks",
    select: "id,title,created_at",
  },
  reminder: {
    label: "准备提醒",
    table: "reminder_jobs",
    select: "id,reason,created_at",
  },
  delivery: {
    label: "通知记录/待发队列",
    table: "notification_deliveries",
    select: "id,kind,state,created_at",
  },
  note_batch: {
    label: "笔记导入批次",
    table: "note_import_batches",
    select: "id,source_label,created_at",
  },
  note_source: {
    label: "笔记来源原文",
    table: "note_sources",
    select: "id,source_label,created_at",
  },
  note_revision: {
    label: "笔记版本快照",
    table: "note_revisions",
    select: "id,created_at",
  },
};
type Key = keyof typeof types;
type Row = {
  id: string;
  created_at: string;
  title?: string;
  filename?: string;
  source_label?: string;
  notes?: string;
  url?: string;
  reason?: string;
  kind?: string;
  state?: string;
  payload?: { title?: string };
  new_record?: { title?: string };
};
export default function DataManager() {
  const [type, setType] = useState<Key>("proposal"),
    [rows, setRows] = useState<Row[]>([]),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [confirmation, setConfirmation] = useState("");
  async function load() {
    const d = types[type];
    const r = await browserDB()
      .from(d.table)
      .select(d.select)
      .order("created_at", { ascending: false })
      .limit(100);
    if (r.error) throw Error("记录无法读取，请先登录或确认数据库更新。");
    setRows(r.data as unknown as Row[]);
  }
  useEffect(() => {
    if (configured()) load().catch((e) => setMessage(e.message));
  }, [type]);
  const label = (r: Row) =>
    r.title ||
    r.payload?.title ||
    r.new_record?.title ||
    r.filename ||
    r.source_label ||
    r.notes ||
    r.url ||
    r.reason ||
    r.kind ||
    "记录";
  async function remove(row: Row) {
    if (
      !window.confirm(
        `永久删除这条${types[type].label}？${type.includes("batch") ? "已导入的日程或笔记保留。" : type === "source" || type === "note_source" ? "其他导入批次或历史里可能仍保留原文，需分别清理。" : type === "delivery" ? "不会从Telegram撤回消息；正在发送的记录无法删除。" : "此操作不能恢复。"}`,
      )
    )
      return;
    setBusy(true);
    try {
      if (type.startsWith("note_")) {
        const r = await browserDB().rpc("delete_note_record", {
          record_type: type.slice(5),
          target: row.id,
        });
        if (r.error) throw Error("删除失败");
      } else await deleteOwned(type, row.id);
      await load();
      setMessage("记录已删除。");
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
        <h1>管理与删除</h1>
        <Link href="/trash">日程 / 笔记回收站</Link>
      </header>
      <p className="muted">
        按记录类型清理，最多显示最近100条；删除后会补上后续记录。删除历史不改变当前内容；通知去重指纹会保留以避免重复发送。已发Telegram消息不在此处撤回。
      </p>
      <label>
        记录类型
        <select
          value={type}
          disabled={busy}
          onChange={(e) => setType(e.target.value as Key)}
        >
          {Object.entries(types).map(([k, v]) => (
            <option key={k} value={k}>
              {v.label}
            </option>
          ))}
        </select>
      </label>
      <p role="status">{message}</p>
      {rows.map((r) => (
        <div className="panel trash-row" key={r.id}>
          <div>
            <strong>{label(r)}</strong>
            <small>
              {r.created_at}
              {r.state ? " · " + r.state : ""}
            </small>
          </div>
          <button
            disabled={busy || r.state === "sending"}
            onClick={() => void remove(r)}
          >
            删除
          </button>
        </div>
      ))}
      {!rows.length && <p className="muted">暂无记录</p>}
      <details className="panel">
        <summary>永久删除账号及所有内容</summary>
        <p>
          将删除账号、日程、笔记、来源、历史和附件，无法恢复。请先导出需要保留的资料。不会撤回Telegram已发消息，也不会删除项目配置的机器人密钥。
        </p>
        <label>
          输入「永久删除我的账号」
          <input
            value={confirmation}
            onChange={(e) => setConfirmation(e.target.value)}
            autoComplete="off"
          />
        </label>
        <button
          disabled={busy || confirmation !== "永久删除我的账号"}
          onClick={async () => {
            if (!window.confirm("最后确认：永久删除账号及全部内容？无法恢复。"))
              return;
            setBusy(true);
            try {
              const r = await fetch("/api/account", {
                method: "DELETE",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ confirmation }),
              });
              const data = await r.json();
              if (!r.ok) throw Error(data.error || "删除失败");
              await browserDB().auth.signOut();
              window.location.href = "/";
            } catch (e) {
              setMessage(e instanceof Error ? e.message : "删除失败");
            } finally {
              setBusy(false);
            }
          }}
        >
          永久删除账号
        </button>
      </details>
    </main>
  );
}
