import { describe, it, expect, vi, afterEach } from "vitest";
import {
  chatText,
  ruleNotes,
  prepareNoteProposals,
  fingerprint,
} from "../lib/note-ingestion";
import { aiNotes } from "../lib/note-ai";
const text =
  "# 2026-10-19 C4D\n知识点\n对象分层。\n步骤\n1. 创建物体\n问题\n如何选择？\n待办\n- [ ] 练习\n# 2026-10-26 C4D\n材质练习 [[相关笔记]]";
const existing = {
  id: "00000000-0000-4000-8000-000000000001",
  title: "C4D · 2026-10-19",
  course: "C4D",
  lesson_date: "2026-10-19",
  version: 3,
  source_fingerprint: null,
};
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
describe("controlled classroom note ingestion", () => {
  it("splits lessons, retains raw text and organizes all four sections without inventing dates", () => {
    const p = ruleNotes(text, "C4D");
    expect(p).toHaveLength(2);
    expect(p[0].lesson_date).toBe("2026-10-19");
    expect(p[0].body).toContain("操作步骤");
    expect(p[0].body).toContain("创建物体");
    expect(p[0].body).toContain("待办");
    expect(p[0].source_excerpt).toContain("对象分层");
    expect(ruleNotes("明天需要练习C4D", "C4D")[0].lesson_date).toBeNull();
  });
  it("reads the active ChatGPT branch and keeps assistant statements labelled unverified", () => {
    const source = {
      title: "Class chat",
      current_node: "b",
      mapping: {
        a: {
          message: {
            author: { role: "user" },
            content: { parts: ["课堂记录"] },
          },
        },
        b: {
          parent: "a",
          message: {
            author: { role: "assistant" },
            content: { parts: ["应当核实的说法"] },
          },
        },
        unused: {
          parent: "a",
          message: {
            author: { role: "assistant" },
            content: { parts: ["旧分支内容"] },
          },
        },
      },
    };
    const raw = chatText(
      Buffer.from(JSON.stringify(source)),
      "conversations.json",
    );
    expect(raw).toContain("用户原文");
    expect(raw).toContain("AI 回答：未经核实");
    expect(raw).not.toContain("旧分支内容");
  });
  it("skips exact and within-file duplicates while demanding review of matching lessons", () => {
    const p = ruleNotes(text, "C4D")[0];
    expect(prepareNoteProposals([p], text, [existing], [])[0].action).toBe(
      "review",
    );
    expect(
      prepareNoteProposals(
        [p],
        text,
        [{ ...existing, source_fingerprint: p.fingerprint }],
        [],
      )[0].action,
    ).toBe("skip");
    expect(
      prepareNoteProposals([p, p], text, [], []).map((p) => p.action),
    ).toEqual(["create", "skip"]);
    expect(fingerprint("a  b")).toBe(fingerprint("a\nb"));
  });
  it("proposes only owner-supplied events matching course and London lesson date", () => {
    const p = ruleNotes(text, "C4D")[0];
    const event = {
      id: "20000000-0000-4000-8000-000000000001",
      title: "Skills C4D",
      course: "DFPI",
      start_at: "2026-10-19T09:00:00Z",
    };
    const r = prepareNoteProposals(
      [{ ...p, event_ids: ["20000000-0000-4000-8000-000000000099"] }],
      text,
      [],
      [event],
    );
    expect(r[0].payload.event_ids).toEqual([event.id]);
  });
  it("rejects source fabrication and drops dates unsupported by the original", () => {
    const p = ruleNotes("C4D 原始资料", "C4D")[0];
    expect(() =>
      prepareNoteProposals(
        [{ ...p, source_excerpt: "编造的来源" }],
        "C4D 原始资料",
        [],
        [],
      ),
    ).toThrow("来源引用");
    expect(
      prepareNoteProposals(
        [{ ...p, lesson_date: "2026-10-19" }],
        "C4D 原始资料",
        [],
        [],
      )[0].payload.lesson_date,
    ).toBeNull();
  });
  it("makes AI configuration explicit and validates structured model output without writing data", async () => {
    await expect(aiNotes("课堂内容", "C4D", [])).rejects.toThrow("尚未配置");
    vi.stubEnv("OPENAI_API_KEY", "fixture-not-a-real-key");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [
                {
                  finish_reason: "stop",
                  message: {
                    content: JSON.stringify({
                      notes: [
                        {
                          title: "C4D lesson",
                          course: "C4D",
                          lesson_date: null,
                          points: ["概念"],
                          steps: ["操作"],
                          questions: [],
                          todos: ["练习"],
                          tags: ["C4D"],
                          event_ids: [],
                          related_titles: [],
                          source_excerpt: "课堂内容",
                        },
                      ],
                    }),
                  },
                },
              ],
            }),
            { status: 200 },
          ),
      ),
    );
    const notes = await aiNotes("课堂内容", "C4D", []);
    expect(notes[0].body).toContain("AI 整理，未经来源核实");
    expect(notes[0].source_excerpt).toBe("课堂内容");
  });
  it("does not expose provider error bodies or pretend failed AI requests were successful", async () => {
    vi.stubEnv("OPENAI_API_KEY", "fixture-not-a-real-key");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response("private provider response", { status: 401 }),
      ),
    );
    await expect(aiNotes("课堂内容", "C4D", [])).rejects.toThrow("HTTP 401");
  });
});
