import { describe, it, expect } from "vitest";
import { DateTime } from "luxon";
import {
  authorizedWebhook,
  briefing,
  briefKey,
  conflicts,
  dueBrief,
  quietUntil,
  splitMessage,
  type CalendarEvent,
} from "../supabase/functions/_shared/core";
import {
  eventInput,
  naturalProposal,
  parseInstant,
  rowProposal,
  deduplicate,
} from "../lib/ingestion";
const event = (
  patch: Partial<CalendarEvent> = {},
): CalendarEvent & { version: number } => ({
  id: "a",
  version: 1,
  title: "Coding",
  category: "academic",
  status: "confirmed",
  priority: "normal",
  start_at: "2026-10-14T09:00:00Z",
  end_at: "2026-10-14T12:00:00Z",
  deadline_at: null,
  ...patch,
});
describe("London scheduling", () => {
  it.each([
    ["2026-01-14T07:00:00Z", true],
    ["2026-07-14T06:00:00Z", true],
    ["2026-03-29T06:00:00Z", true],
    ["2026-10-25T07:00:00Z", true],
    ["2026-07-14T07:00:00Z", false],
  ])("07:00 at %s", (at, expected) =>
    expect(dueBrief(at, "Europe/London", "morning", "07:00")).toBe(expected),
  );
  it("weekly is Sunday at 19 local", () => {
    expect(
      dueBrief("2026-07-19T18:00:00Z", "Europe/London", "weekly", "19:00"),
    ).toBe(true);
    expect(
      dueBrief("2026-07-20T18:00:00Z", "Europe/London", "weekly", "19:00"),
    ).toBe(false);
  });
  it("22:00 during BST", () =>
    expect(
      dueBrief("2026-07-14T21:00:00Z", "Europe/London", "tomorrow", "22:00"),
    ).toBe(true));
  it("repeated fall-back times get the same key", () =>
    expect(
      briefKey("u", "morning", "2026-10-25T00:30:00Z", "Europe/London"),
    ).toBe(briefKey("u", "morning", "2026-10-25T01:30:00Z", "Europe/London")));
  it("respects quiet hours across midnight and DST", () => {
    expect(
      quietUntil("2026-03-28T23:30:00Z", "Europe/London", "23:00", "07:00"),
    ).toBe("2026-03-29T06:00:00.000Z");
    expect(
      quietUntil("2026-10-24T22:30:00Z", "Europe/London", "23:00", "07:00"),
    ).toBe("2026-10-25T07:00:00.000Z");
    expect(
      quietUntil("2026-07-14T06:00:00Z", "Europe/London", "23:00", "07:00"),
    ).toBeNull();
  });
  it("never infers dates or DST gap/fold times", () => {
    expect(parseInstant("2026-10-14", "Europe/London")).toBeNull();
    expect(parseInstant("11/24 10:00", "Europe/London")).toBeNull();
    expect(parseInstant("2026-03-29T01:30", "Europe/London")).toBeNull();
    expect(parseInstant("2026-10-25T01:30", "Europe/London")).toBeNull();
    expect(parseInstant("2026-10-25T01:30:00+01:00", "Europe/London")).toBe(
      "2026-10-25T00:30:00.000Z",
    );
  });
});
describe("source-aware updates", () => {
  it("first choice stays applied", () =>
    expect(
      naturalProposal("11/24 photography workshop first choice", []).payload
        .status,
    ).toBe("applied"));
  it("keeps deadline separate from attendance", () => {
    const p = rowProposal(
      {
        title: "Research dossier",
        deadline: "2026-11-11T10:00",
        status: "planned",
      },
      "excel",
    );
    expect(p.payload.start_at).toBeNull();
    expect(p.payload.deadline_at).toBeTruthy();
    expect(p.source.original_record).toBeDefined();
  });
  it("does not assign a clock time to date-only deadlines", () => {
    const p = rowProposal(
      { title: "Research dossier", deadline: "2026-11-11" },
      "excel",
    );
    expect(p.payload.deadline_at).toBeNull();
    expect(p.warnings.length).toBeGreaterThan(0);
  });
  it("proposes 13:00 end correction without changing start", () => {
    const p = naturalProposal(
      "我周二Coding 13:00下课",
      [
        event({
          title: "Coding Group A",
          start_at: "2026-10-13T09:00:00Z",
          end_at: "2026-10-13T13:00:00Z",
        }),
      ],
      DateTime.fromISO("2026-10-14", { zone: "Europe/London" }),
    );
    expect(p.event_id).toBe("a");
    expect(p.payload.end_at).toBe("2026-10-13T12:00:00.000Z");
    expect(p.payload.start_at).toBeUndefined();
  });
  it("never changes multiple title matches", () =>
    expect(
      naturalProposal("取消Coding", [event(), event({ id: "b" })]).event_id,
    ).toBeUndefined());
  it("rejects end before start and unsafe links", () => {
    expect(
      eventInput.safeParse({
        title: "bad",
        start_at: "2026-10-14T10:00:00Z",
        end_at: "2026-10-14T09:00:00Z",
      }).success,
    ).toBe(false);
    expect(
      eventInput.safeParse({ title: "bad", meeting_url: "javascript:alert(1)" })
        .success,
    ).toBe(false);
  });
  it("deduplicates same title + instants and retains source", () => {
    const p = rowProposal(
      {
        title: "Coding",
        start_at: "2026-10-14T10:00",
        end_at: "2026-10-14T13:00",
      },
      "csv",
    );
    const d = deduplicate(p, [event()]);
    expect(d.event_id).toBe("a");
    expect(d.source).toBe(p.source);
  });
});
describe("notifications and conflicts", () => {
  it("preserves unconfirmed distinction and original links", () => {
    const message = briefing(
      "morning",
      "2026-10-14T06:00:00Z",
      "Europe/London",
      [
        event({
          status: "applied",
          event_sources: [{ url: "https://ucl.ac.uk/source" }],
        }),
      ],
    );
    expect(message).toContain("已申请");
    expect(message).not.toContain("[已确认]");
    expect(message).toContain("https://ucl.ac.uk/source");
    expect(message).toContain("10:00");
  });
  it("next week starts on Monday, not current Sunday", () => {
    const m = briefing("weekly", "2026-10-18T18:00:00Z", "Europe/London", [
      event({
        title: "Next",
        start_at: "2026-10-19T09:00:00Z",
        end_at: "2026-10-19T10:00:00Z",
      }),
    ]);
    expect(m).toContain("2026-10-19");
    expect(m).toContain("Next");
  });
  it("detects overlaps, transit gaps and deadline conflicts", () => {
    const events = [
      event(),
      event({
        id: "b",
        title: "CNC",
        start_at: "2026-10-14T11:00:00Z",
        end_at: "2026-10-14T12:30:00Z",
        location: "Stratford",
      }),
      event({
        id: "c",
        title: "B-made",
        start_at: "2026-10-14T12:40:00Z",
        end_at: "2026-10-14T14:00:00Z",
        location: "Bloomsbury",
        deadline_at: "2026-10-14T10:00:00Z",
      }),
    ];
    expect(conflicts(events).map((c) => c.kind)).toEqual(
      expect.arrayContaining(["overlap", "travel", "deadline"]),
    );
  });
  it("excludes cancelled events", () =>
    expect(
      conflicts([event(), event({ id: "b", status: "cancelled" })]),
    ).toHaveLength(0));
  it("requires webhook secret and private chat", () => {
    expect(authorizedWebhook("secret", "secret", "private")).toBe(true);
    expect(authorizedWebhook("secret", "wrong", "private")).toBe(false);
    expect(authorizedWebhook("secret", "secret", "group")).toBe(false);
    expect(authorizedWebhook(undefined, null, "private")).toBe(false);
  });
  it("keeps messages within limits without broken surrogate pairs", () => {
    const parts = splitMessage("🌅".repeat(4000));
    expect(parts.every((p) => p.length <= 3500)).toBe(true);
    expect(parts.join("")).toBe("🌅".repeat(4000));
  });
});

describe("calendar lanes", () => {
  it("keeps overlapping events visible and carries overnight activities into the next day", async () => {
    const { layoutDay } = await import("../supabase/functions/_shared/core");
    const items = layoutDay(
      [
        event(),
        event({
          id: "b",
          start_at: "2026-10-14T10:00:00Z",
          end_at: "2026-10-14T11:00:00Z",
        }),
      ],
      "2026-10-14",
      "Europe/London",
    );
    expect(items[0].lanes).toBe(2);
    expect(items[0].lane).not.toBe(items[1].lane);
    const overnight = layoutDay(
      [
        event({
          start_at: "2026-10-13T22:00:00Z",
          end_at: "2026-10-14T01:00:00Z",
        }),
      ],
      "2026-10-14",
      "Europe/London",
    );
    expect(overnight[0].start).toBe(0);
    expect(overnight[0].end).toBe(120);
  });
});

describe("private linking code parsing", () => {
  it("accepts copied whitespace and canonicalizes hex case without exposing code content", async () => {
    const { parseLinkCode } =
      await import("../supabase/functions/_shared/core");
    const code = "YING-" + "A".repeat(24);
    expect(parseLinkCode(" \n" + code + "\n ")).toBe(code);
    expect(
      parseLinkCode("/start@ying_os_calendar_bot " + code.toLowerCase()),
    ).toBe(code);
  });
  it("rejects incomplete codes and unrelated text", async () => {
    const { parseLinkCode } =
      await import("../supabase/functions/_shared/core");
    expect(parseLinkCode("YING-short")).toBeNull();
    expect(parseLinkCode("please connect me")).toBeNull();
    expect(parseLinkCode(null)).toBeNull();
  });
});
