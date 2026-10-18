"use client";
import { browserDB } from "./supabase";
export async function cleanupFiles() {
  const db = browserDB();
  const r = await db.from("file_deletion_jobs").select("id,path").limit(100);
  if (r.error) throw Error("附件清理队列无法读取。");
  let failures = 0;
  for (const job of r.data || []) {
    const removed = await db.storage.from("event-board").remove([job.path]);
    if (removed.error) {
      failures++;
      continue;
    }
    const done = await db.from("file_deletion_jobs").delete().eq("id", job.id);
    if (done.error) failures++;
  }
  return failures;
}
export async function deleteOwned(type: string, id: string) {
  const r = await browserDB().rpc("delete_owned_record", {
    record_type: type,
    target: id,
  });
  if (r.error)
    throw Error("删除未完成，记录可能已变化，或有提醒正在发送；请检查后重试。");
  if (type === "card") {
    const n = await cleanupFiles();
    if (n) throw Error("卡片已删除，但部分附件待清理。可到回收站重试清理。");
  }
}
