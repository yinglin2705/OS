const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const uid = "00000000-0000-4000-8000-000000000071";
const jid = "60000000-0000-4000-8000-000000000071";
const cid = "50000000-0000-4000-8000-000000000071";
const project = new URL(
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
    "https://flhwcojxhsyjpzfqxttx.supabase.co",
).hostname.split(".")[0];
const base = process.env.YING_BROWSER_BASE_URL || "http://localhost:3102";
if (!["localhost", "127.0.0.1"].includes(new URL(base).hostname))
  throw Error("Fixture browser tests require a local server.");
(async () => {
  const browser = await chromium.launch({
    executablePath:
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox"],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const token =
    Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString(
      "base64url",
    ) +
    "." +
    Buffer.from(
      JSON.stringify({
        sub: uid,
        exp: Math.floor(Date.now() / 1000) + 3600,
        role: "authenticated",
      }),
    ).toString("base64url") +
    ".local-test-signature";
  await context.addCookies([
    {
      name: `sb-${project}-auth-token`,
      value:
        "base64-" +
        Buffer.from(
          JSON.stringify({
            access_token: token,
            refresh_token: "local-test-refresh",
            expires_at: Math.floor(Date.now() / 1000) + 3600,
            expires_in: 3600,
            token_type: "bearer",
            user: {
              id: uid,
              aud: "authenticated",
              role: "authenticated",
              email: "fixture@example.invalid",
            },
          }),
        ).toString("base64url"),
      url: base,
      httpOnly: false,
      sameSite: "Lax",
    },
  ]);

  const analysis = {
    requirements: [{ kind: "essential", quote: "C4D experience required" }],
    deadline_date: null,
    deadline_quote: null,
    hours: { min: 16, max: 20, quote: "16–20 hours per week" },
    flexible: true,
    flexibility_quote: "Part-time",
    eligibility_risks: ["Must have right to work in UK."],
    warnings: ["规则提取，需核实原文。"],
    engine: "rules-v1",
  };
  const claims = [
    {
      id: cid,
      kind: "skill",
      statement: "Completed a C4D class exercise.",
      keywords: ["C4D"],
      source_text: "C4D class exercise record.",
      source_url: "https://example.org/evidence",
      verification: "user_verified",
      verified_at: new Date().toISOString(),
    },
  ];
  const jobs = [
    {
      id: jid,
      title: "Design studio assistant",
      employer: "Fixture studio",
      location: "London",
      source_url: "https://example.org/jobs/fixture",
      raw_jd:
        "Essential: C4D experience required. Part-time 16–20 hours per week.",
      analysis,
      status: "saved",
      application_notes: "",
      policy_decision: "unknown",
      policy_url: null,
      policy_quote: null,
      policy_reviewed_at: null,
      last_seen_at: null,
      availability: "unknown",
      origin: "manual",
      updated_at: new Date().toISOString(),
    },
  ];
  const sources = [],
    docs = [],
    calls = [],
    errors = [];
  await context.route(`https://${project}.supabase.co/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/auth/v1/user")
      return route.fulfill({
        json: {
          id: uid,
          aud: "authenticated",
          role: "authenticated",
          email: "fixture@example.invalid",
        },
      });
    const data = {
      career_claims: claims,
      career_opportunities: jobs,
      career_sources: sources,
      career_documents: docs,
      career_application_history: [],
      career_discovery_runs: [],
    }[path.split("/").at(-1)];
    if (!data) throw Error("Unexpected Supabase fixture endpoint");
    return route.fulfill({ json: data });
  });
  await context.route(`${base}/api/career`, async (route) => {
    const b = route.request().postDataJSON();
    calls.push(b);
    if (b.action === "analyse")
      return route.fulfill({
        json: {
          analysis,
          match: {
            score: 85,
            rows: [
              {
                kind: "essential",
                quote: "C4D experience required",
                evidence: claims,
              },
            ],
            explanation: "证据覆盖，不是录用概率。",
          },
        },
      });
    if (b.action === "policy")
      Object.assign(jobs[0], {
        policy_decision: b.data.decision,
        policy_url: b.data.source_url,
        policy_quote: b.data.quote,
        policy_reviewed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    else if (b.action === "draft")
      docs.push({
        id: crypto.randomUUID(),
        kind: b.kind,
        version: docs.length + 1,
        body: "# CV evidence draft\nCompleted a C4D class exercise.",
        evidence_snapshot: claims,
        policy_snapshot: { decision: "allowed" },
        analysis_snapshot: { raw_jd: jobs[0].raw_jd },
        created_at: new Date().toISOString(),
      });
    else if (b.action === "status")
      Object.assign(jobs[0], {
        status: b.status,
        application_notes: b.notes,
        updated_at: new Date().toISOString(),
      });
    else if (b.action === "claim") {
      assert.deepEqual(
        Object.keys(b.data).sort(),
        [
          "kind",
          "statement",
          "keywords",
          "source_url",
          "source_text",
          "verification",
        ].sort(),
      );
      Object.assign(claims[0], b.data);
    } else if (b.action === "source")
      sources.push({
        id: crypto.randomUUID(),
        ...b.data,
        approved_at: new Date().toISOString(),
      });
    else if (b.action === "delete" && b.table === "career_opportunities")
      jobs.splice(0, 1);
    else throw Error("Unexpected career fixture action");
    return route.fulfill({ json: { data: "fixture-saved" } });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  await page.goto(`${base}/career`);
  await page.getByRole("button", { name: /Design studio assistant/ }).click();
  await page.getByText("85/100", { exact: true }).waitFor();
  assert(
    await page
      .getByRole("button", { name: "生成新的证据草稿", exact: true })
      .isDisabled(),
  );
  assert.equal(calls.filter((c) => c.action === "draft").length, 0);
  await page.getByLabel("政策结论").selectOption("allowed");
  await page.getByLabel("政策来源链接").fill("https://example.org/policy");
  await page
    .getByLabel("政策原文", { exact: true })
    .fill("We explicitly allow AI assistance with application preparation.");
  await page.getByLabel("我已核实原文和适用范围；这不是法律判断").check();
  await page.getByRole("button", { name: "保存政策核实", exact: true }).click();
  await page
    .getByText("政策证据已保存；生成材料还会经过数据库限制检查。", {
      exact: true,
    })
    .waitFor();
  await page
    .getByLabel("Completed a C4D class exercise.", { exact: true })
    .check();
  await page
    .getByRole("button", { name: "生成新的证据草稿", exact: true })
    .click();
  await page.getByRole("button", { name: /cv · v1/ }).click();
  await page
    .getByText("# CV evidence draft\nCompleted a C4D class exercise.", {
      exact: true,
    })
    .waitFor();
  assert.equal(calls.find((c) => c.action === "draft").approved, true);
  assert.deepEqual(calls.find((c) => c.action === "draft").claim_ids, [cid]);
  assert.equal(
    await page
      .getByRole("button", { name: "本人审阅后导出 Markdown", exact: true })
      .isEnabled(),
    true,
  );
  assert.equal(jobs[0].status, "saved");
  await page.locator('select[name="status"]').selectOption("shortlisted");
  await page.getByRole("button", { name: "保存进度", exact: true }).click();
  await page
    .getByText("申请状态已记录，未向雇主发送任何内容。", { exact: true })
    .waitFor();
  assert.equal(jobs[0].status, "shortlisted");
  await page.getByLabel("政策结论").selectOption("analysis_only");
  await page.getByLabel("我已核实原文和适用范围；这不是法律判断").check();
  await page.getByRole("button", { name: "保存政策核实", exact: true }).click();
  await page
    .getByText("政策证据已保存；生成材料还会经过数据库限制检查。", {
      exact: true,
    })
    .waitFor();
  await page.getByRole("button", { name: /cv · v1/ }).click();
  assert.equal(
    await page
      .getByRole("button", { name: "本人审阅后导出 Markdown", exact: true })
      .isDisabled(),
    true,
  );
  await page.screenshot({
    path: "/tmp/ying-career-desktop.png",
    fullPage: false,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 2,
    ),
  );
  await page.getByRole("button", { name: /Master Profile/ }).click();
  await page
    .getByRole("heading", { name: "Master Career Profile", exact: true })
    .waitFor();
  await page
    .getByText("Completed a C4D class exercise.", { exact: true })
    .waitFor();
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await page.getByRole("button", { name: "保存资料", exact: true }).click();
  await page.getByText("职业资料已保存。", { exact: true }).waitFor();
  assert.equal(calls.filter((c) => c.action === "claim").length, 1);
  await page
    .getByRole("button", { name: "发现来源与运行记录", exact: true })
    .click();
  await page.getByLabel("雇主名称 / 来源名称").fill("Fixture studio");
  await page.getByLabel("Greenhouse board token").fill("fixture-studio");
  await page
    .getByLabel("已阅读的API / 来源条款链接")
    .fill("https://example.org/api-terms");
  await page
    .getByLabel("条款审查记录")
    .fill("Fixture: read-only API access approved after terms review.");
  await page.getByLabel("启用定时只读发现").check();
  assert(
    await page
      .getByRole("button", { name: "保存来源与批准", exact: true })
      .isDisabled(),
  );
  await page.getByLabel("我已审查条款，批准此来源和上述后台读取范围").check();
  await page
    .getByRole("button", { name: "保存来源与批准", exact: true })
    .click();
  await page
    .getByText(
      "来源设置已保存。启用来源将在下一次GitHub Actions任务中只读检查。",
      { exact: true },
    )
    .waitFor();
  assert.equal(calls.find((c) => c.action === "source").data.approved, true);
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 2,
    ),
  );
  await page.getByRole("button", { name: /机会与申请/ }).click();
  await page.getByRole("button", { name: "删除机会", exact: true }).click();
  await page.getByText("已删除。", { exact: true }).waitFor();
  assert.equal(jobs.length, 0);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      authenticated_dashboard: true,
      quoted_analysis: true,
      unknown_policy_blocks_drafting: true,
      explicit_policy_review: true,
      verified_evidence_selection: true,
      version_preview: true,
      no_automatic_application: true,
      manual_status: true,
      source_approval: true,
      opportunity_delete: true,
      mobile_layout: true,
      page_errors: errors.length,
    }),
  );
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
