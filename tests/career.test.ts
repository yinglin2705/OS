import { describe, it, expect, vi } from "vitest";
import {
  analyseJD,
  matchJob,
  canDraft,
  draftMaterial,
  phraseIn,
  type Claim,
} from "../lib/career/engine";
import {
  boardURL,
  robotsAllows,
  htmlText,
  discoverBoard,
  boundedFetch,
  sqlLiteral,
} from "../lib/career/discovery";
const raw =
  "London creative studio\nEssential requirements:\n- C4D skills required\n- 3 years of lighting experience\nDesirable:\n- Python preferred\nBenefits:\nFlexible hours, part-time 16–20 hours per week\nClosing date: 25 October 2026\nApplicants must have the right to work in the UK; visa sponsorship unavailable.";
const claim: Claim = {
  id: "50000000-0000-4000-8000-000000000001",
  kind: "skill",
  statement: "I practised C4D in a class.",
  keywords: ["C4D"],
  source_url: "https://example.org/portfolio",
  source_text: "Class record: C4D exercise.",
  verification: "user_verified",
  verified_at: "2026-10-19T08:00:00Z",
};
const policy = {
  decision: "allowed",
  quote:
    "We allow AI assistance with application preparation; verify all facts.",
  source_url: "https://example.org/policy",
  reviewed_at: "2026-10-19T08:00:00Z",
};
describe("source-backed career analysis", () => {
  it("extracts exact requirements, full-year deadline, explicit weekly hours and eligibility quotes", () => {
    const a = analyseJD(raw);
    expect(a.requirements).toHaveLength(4);
    expect(a.requirements[0]).toEqual({
      kind: "essential",
      quote: "C4D skills required",
    });
    expect(a.hours).toEqual({
      min: 16,
      max: 20,
      quote: "16–20 hours per week",
    });
    expect(a.deadline_date).toBe("2026-10-25");
    expect(a.eligibility_risks[0]).toContain("right to work");
  });
  it("keeps missing years, times, hours and unstructured requirements unknown", () => {
    const a = analyseJD(
      "An interesting London role.\nClosing date: 25 October\nSalary £20 per hour.",
    );
    expect(a.deadline_date).toBeNull();
    expect(a.hours).toBeNull();
    expect(a.requirements).toEqual([]);
    expect(matchJob(a, []).score).toBeNull();
  });
  it("ignores unverified or unsupported keywords and explains partial evidence coverage", () => {
    const a = analyseJD(raw),
      m = matchJob(a, [
        claim,
        {
          ...claim,
          id: "other",
          keywords: ["Python"],
          verification: "unverified",
        },
      ]);
    expect(m.rows[0].evidence[0].id).toBe(claim.id);
    expect(m.rows[1].evidence).toEqual([]);
    expect(m.rows[2].evidence).toEqual([]);
    expect(m.score).toBe(35);
    expect(
      matchJob(a, [{ ...claim, source_text: "No evidence supplied" }]).score,
    ).toBe(10);
    expect(m.explanation).toContain("不是录用概率");
  });
  it("does not confuse embedded words with skill evidence", () => {
    expect(phraseIn("partial payment", "art")).toBe(false);
    expect(phraseIn("C4D, lighting", "C4D")).toBe(true);
  });
  it("blocks unknown, analysis-only, prohibitions and restrictive source text", () => {
    expect(canDraft(null).allowed).toBe(false);
    expect(canDraft({ ...policy, decision: "analysis_only" }).allowed).toBe(
      false,
    );
    for (const quote of [
      "Do not use AI in your application.",
      "AI must not be used for applications.",
      "Applications without AI assistance only.",
    ])
      expect(canDraft({ ...policy, quote }).allowed).toBe(false);
    expect(canDraft(policy).allowed).toBe(true);
  });
  it("creates evidence drafts without inventing qualifications and refuses empty verified profiles", () => {
    const draft = draftMaterial(
      "cv",
      { title: "Lighting assistant", employer: "Example studio" },
      [claim],
      policy,
    );
    expect(draft.body).toContain(claim.statement);
    expect(draft.body).not.toContain("3 years");
    expect(draft.evidence[0].source_text).toBe(claim.source_text);
    expect(() =>
      draftMaterial(
        "cover_letter",
        { title: "Role", employer: "Studio" },
        [{ ...claim, verification: "unverified" }],
        policy,
      ),
    ).toThrow("核实");
  });
});
describe("approved official discovery boundaries", () => {
  it("rejects arbitrary URLs and SQL string breakout", () => {
    expect(() => boardURL("../private")).toThrow();
    expect(() => boardURL("https://localhost")).toThrow();
    expect(boardURL("studio")).toBe(
      "https://boards-api.greenhouse.io/v1/boards/studio/jobs?content=true",
    );
    expect(sqlLiteral("test'; drop table users;--")).toBe(
      "'test''; drop table users;--'",
    );
  });
  it("honours restrictive robots, wildcard specificity and explicit agent rules", () => {
    expect(
      robotsAllows("User-agent: *\nDisallow: /v1/", "/v1/boards/x/jobs"),
    ).toBe(false);
    expect(
      robotsAllows(
        "User-agent: *\nDisallow: /\nAllow: /v1/boards/",
        "/v1/boards/x/jobs",
      ),
    ).toBe(true);
    expect(
      robotsAllows(
        "User-agent: YINGOSCareer\nDisallow: /\nUser-agent: *\nAllow: /",
        "/v1/jobs",
      ),
    ).toBe(false);
    expect(robotsAllows("User-agent: *\nDisallow: /*/jobs$", "/v1/jobs")).toBe(
      false,
    );
  });
  it("never fetches a private or unapproved host", async () => {
    const f = vi.fn();
    await expect(
      boundedFetch("https://127.0.0.1/secrets", 100, f),
    ).rejects.toThrow("Unapproved");
    expect(f).not.toHaveBeenCalled();
  });
  it("does not follow redirects, retries or disallowed robots paths", async () => {
    const f = vi.fn<typeof fetch>(
      async () => new Response("User-agent: *\nDisallow: /", { status: 200 }),
    );
    const r = await discoverBoard(
      { board_token: "studio", label: "Studio", keywords: ["design"] },
      f,
    );
    expect(r.state).toBe("skipped");
    expect(f).toHaveBeenCalledTimes(1);
    expect(f.mock.calls[0][1]).toMatchObject({ redirect: "error" });
  });
  it("skips API requests where crawl delay requires review", async () => {
    const f = vi.fn(
      async () => new Response("User-agent: *\nCrawl-delay: 10\nAllow: /"),
    );
    expect(
      (
        await discoverBoard(
          { board_token: "studio", label: "Studio", keywords: ["design"] },
          f,
        )
      ).state,
    ).toBe("skipped");
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("filters non-London and expired jobs and prioritises explicit part-time jobs", async () => {
    const job = (id: number, location: string, content: string) => ({
      id,
      title: "Creative design assistant",
      location: { name: location },
      content,
      absolute_url: `https://example.org/jobs/${id}`,
    });
    const f = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith("robots.txt")
        ? new Response("", { status: 404 })
        : Response.json({
            jobs: [
              job(1, "Paris", "A creative design role in a lovely studio."),
              job(2, "London", "Design role.\nClosing date: 2025-01-01"),
              job(3, "London", "Design role.\nPart-time 16 hours per week."),
              job(4, "London", "Design role.\nFull-time 40 hours per week."),
            ],
          }),
    );
    const r = await discoverBoard(
      { board_token: "studio", label: "Studio", keywords: ["design"] },
      f,
      new Date("2026-10-19T08:00:00Z"),
    );
    expect(r.jobs.map((j) => j.external_id)).toEqual(["3", "4"]);
    expect(f).toHaveBeenCalledTimes(2);
  });
  it("bounds streaming content and handles rate limits without retrying", async () => {
    await expect(
      boundedFetch(
        boardURL("studio"),
        5,
        async () => new Response("0123456789"),
      ),
    ).rejects.toThrow("limit");
    const f = vi.fn(
      async (url: string | URL | Request) =>
        new Response("", {
          status: String(url).endsWith("robots.txt") ? 404 : 429,
        }),
    );
    expect(
      (
        await discoverBoard(
          { board_token: "studio", label: "Studio", keywords: ["design"] },
          f,
        )
      ).state,
    ).toBe("skipped");
    expect(f).toHaveBeenCalledTimes(2);
  });
  it("treats HTML and embedded instructions as untrusted source text", () => {
    expect(
      htmlText(
        "&lt;p&gt;Design&lt;/p&gt;<script>steal()</script><p>Essential</p>",
      ),
    ).toBe("Design\nEssential");
  });
});
