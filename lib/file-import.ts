import { parse } from "csv-parse/sync";
import ExcelJS from "exceljs";
import ICAL from "ical.js";
import { DateTime } from "luxon";
export const MAX_BYTES = 4 * 1024 * 1024,
  MAX_ROWS = 500;
export type Imported = {
  sourceType: string;
  rows: Record<string, unknown>[];
  messages: { text: string; createdAt?: number }[];
};
export function inspectXlsx(bytes: Buffer) {
  // Read declared ZIP sizes before ExcelJS decompresses XML. Reject ZIP64 and large expansion.
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--)
    if (bytes.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  if (end < 0) throw new Error("无效的 XLSX 文件");
  const count = bytes.readUInt16LE(end + 10);
  let offset = bytes.readUInt32LE(end + 16);
  let total = 0;
  if (count > 2000 || offset >= bytes.length)
    throw new Error("Excel 文件过大或使用不支持的 ZIP 格式");
  for (let i = 0; i < count; i++) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== 0x02014b50)
      throw new Error("Excel ZIP 索引无效");
    const size = bytes.readUInt32LE(offset + 24);
    total += size;
    if (
      size === 0xffffffff ||
      total > 20 * 1024 * 1024 ||
      bytes.readUInt16LE(offset + 8) & 1
    )
      throw new Error("Excel 解压大小超过 20 MB 或文件已加密");
    offset +=
      46 +
      bytes.readUInt16LE(offset + 28) +
      bytes.readUInt16LE(offset + 30) +
      bytes.readUInt16LE(offset + 32);
  }
}
export async function fileRecords(
  bytes: Buffer,
  filename: string,
): Promise<Imported> {
  if (bytes.length > MAX_BYTES) throw new Error("文件上限为 4 MB");
  const ext = filename.split(".").pop()?.toLowerCase();
  let rows: Record<string, unknown>[] = [];
  const messages: Imported["messages"] = [];
  let sourceType = "";
  if (ext === "csv") {
    sourceType = "csv";
    rows = parse(bytes.toString("utf8"), {
      columns: true,
      skip_empty_lines: true,
      bom: true,
      max_record_size: 100000,
    });
  } else if (ext === "xlsx") {
    sourceType = "excel";
    inspectXlsx(bytes);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(
      bytes as unknown as Parameters<typeof book.xlsx.load>[0],
    );
    for (const sheet of book.worksheets) {
      const headers: string[] = [];
      sheet
        .getRow(1)
        .eachCell((cell, index) => (headers[index] = String(cell.value || "")));
      sheet.eachRow((row, index) => {
        if (index === 1) return;
        if (rows.length >= MAX_ROWS)
          throw new Error("最多导入 500 条，请拆分文件");
        const value: Record<string, unknown> = { sheet: sheet.name };
        row.eachCell((cell, col) => {
          let raw: unknown = cell.value;
          if (raw instanceof Date)
            raw = DateTime.fromJSDate(raw, { zone: "utc" }).toFormat(
              /[hHsS]/.test(cell.numFmt || "")
                ? "yyyy-MM-dd'T'HH:mm:ss"
                : "yyyy-MM-dd",
            );
          else if (raw && typeof raw === "object") {
            const obj = raw as {
              text?: string;
              result?: unknown;
              richText?: { text: string }[];
              hyperlink?: string;
            };
            raw =
              obj.text ??
              obj.result ??
              obj.richText?.map((x) => x.text).join("") ??
              String(raw);
            if (obj.hyperlink) value[headers[col] + "_link"] = obj.hyperlink;
          }
          if (headers[col]) value[headers[col]] = raw;
        });
        rows.push(value);
      });
    }
  } else if (ext === "ics") {
    sourceType = "ics";
    const root = new ICAL.Component(ICAL.parse(bytes.toString("utf8")));
    for (const item of root.getAllSubcomponents("vevent")) {
      const e = new ICAL.Event(item);
      const iso = (key: string) => {
        const value = item.getFirstPropertyValue(key) as ICAL.Time | null;
        if (!value || value.isDate) return null;
        if (value.zone?.tzid === "UTC") return value.toJSDate().toISOString();
        const tz = String(
          item.getFirstProperty(key)?.getParameter("tzid") || "",
        );
        const raw = value.toString();
        if (!tz) return null; // Floating time is unknown without a zone.
        const d = DateTime.fromISO(raw, { zone: tz });
        return d.isValid &&
          d.getPossibleOffsets().length === 1 &&
          d.toFormat("yyyy-MM-dd'T'HH:mm") === raw.slice(0, 16)
          ? d.toISO()
          : null;
      };
      rows.push({
        title: e.summary,
        start_at: iso("dtstart"),
        end_at: iso("dtend"),
        location: e.location,
        description: e.description,
        source_url: item.getFirstPropertyValue("url"),
        status: "considering",
        uid: e.uid,
        recurrence_rule: item.getFirstPropertyValue("rrule")?.toString(),
        original_ics: item.toString(),
      });
    }
  } else if (ext === "json") {
    sourceType = "chatgpt_export";
    const data = JSON.parse(bytes.toString("utf8"));
    for (const chat of Array.isArray(data) ? data : [data]) {
      if (chat.mapping) {
        for (const node of Object.values(chat.mapping) as {
          message?: {
            create_time?: number;
            author?: { role?: string };
            content?: { parts?: unknown[] };
          };
        }[]) {
          if (node.message?.author?.role === "user")
            for (const part of node.message.content?.parts || [])
              if (typeof part === "string")
                messages.push({
                  text: part,
                  createdAt: node.message.create_time,
                });
        }
      } else if (chat && typeof chat === "object") rows.push(chat);
    }
  } else throw new Error("支持 CSV、XLSX、ICS 或 ChatGPT JSON 导出");
  if (rows.length + messages.length > MAX_ROWS)
    throw new Error("最多导入 500 条，请拆分文件");
  return { rows, messages, sourceType };
}
