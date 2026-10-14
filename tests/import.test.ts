import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { fileRecords, inspectXlsx } from "../lib/file-import";
import { rowProposal } from "../lib/ingestion";
describe("file import", () => {
  it("reads CSV with quoted fields and distinct deadline", async () => {
    const imported = await fileRecords(
      Buffer.from(
        'title,start_at,deadline_at,source_url\n"Research, dossier",,2026-11-11T10:00,https://ucl.ac.uk/course',
      ),
      "sample.csv",
    );
    expect(imported.rows[0].title).toBe("Research, dossier");
    const p = rowProposal(imported.rows[0], imported.sourceType);
    expect(p.payload.start_at).toBeNull();
    expect(p.payload.deadline_at).toBeTruthy();
    expect(p.source.url).toBe("https://ucl.ac.uk/course");
  });
  it("reads multiple Excel term sheets and preserves date-only uncertainty", async () => {
    const book = new ExcelJS.Workbook();
    for (const name of ["Term 1", "Term 2"]) {
      const sheet = book.addWorksheet(name);
      sheet.addRow(["title", "start_at", "source_url"]);
      const row = sheet.addRow([
        "C4D Group A",
        new Date("2026-10-19T00:00:00Z"),
        "https://ucl.ac.uk",
      ]);
      row.getCell(2).numFmt = "dd/mm/yyyy";
    }
    const bytes = Buffer.from(await book.xlsx.writeBuffer());
    const imported = await fileRecords(bytes, "DFPI.xlsx");
    expect(imported.rows).toHaveLength(2);
    expect(imported.rows[1].sheet).toBe("Term 2");
    expect(rowProposal(imported.rows[0], "excel").payload.start_at).toBeNull();
  });
  it("rejects malformed Excel ZIP before decompression", () =>
    expect(() => inspectXlsx(Buffer.alloc(25))).toThrow());
  it("imports Google-style ICS in London but does not confirm attendance", async () => {
    const bytes = Buffer.from(
      "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:test\r\nDTSTART;TZID=Europe/London:20261124T100000\r\nDTEND;TZID=Europe/London:20261124T110000\r\nSUMMARY:Model Photography Workshop\r\nURL:https://ucl.ac.uk/booking\r\nEND:VEVENT\r\nEND:VCALENDAR",
    );
    const imported = await fileRecords(bytes, "google.ics");
    const p = rowProposal(imported.rows[0], "ics");
    expect(p.payload.status).toBe("considering");
    expect(p.payload.start_at).toBe("2026-11-24T10:00:00.000Z");
    expect(p.source.original_record).toBeDefined();
  });
  it("keeps all-day and floating ICS records without invented times", async () => {
    const bytes = Buffer.from(
      "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:a\r\nDTSTART;VALUE=DATE:20261111\r\nSUMMARY:Research dossier deadline\r\nEND:VEVENT\r\nEND:VCALENDAR",
    );
    const imported = await fileRecords(bytes, "a.ics");
    expect(imported.rows[0].start_at).toBeNull();
    expect(imported.rows[0].original_ics).toContain("20261111");
  });
  it("extracts only user text from ChatGPT exports and retains historical timestamp", async () => {
    const exportData = [
      {
        mapping: {
          a: {
            message: {
              author: { role: "assistant" },
              content: { parts: ["Invented schedule"] },
            },
          },
          b: {
            message: {
              author: { role: "user" },
              create_time: 12345,
              content: { parts: ["明天取消Coding"] },
            },
          },
        },
      },
    ];
    const imported = await fileRecords(
      Buffer.from(JSON.stringify(exportData)),
      "conversations.json",
    );
    expect(imported.messages).toEqual([
      { text: "明天取消Coding", createdAt: 12345 },
    ]);
  });
  it("rejects oversized CSV batches", async () =>
    expect(
      fileRecords(
        Buffer.from("title\n" + Array(501).fill("Test").join("\n")),
        "many.csv",
      ),
    ).rejects.toThrow("500"));
});
