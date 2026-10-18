const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const uid = "00000000-0000-4000-8000-000000000011";
const project = new URL(
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
    "https://flhwcojxhsyjpzfqxttx.supabase.co",
).hostname.split(".")[0];
const base = process.env.YING_BROWSER_BASE_URL || "http://localhost:3090";
if (!["localhost", "127.0.0.1"].includes(new URL(base).hostname))
  throw Error("Fixtures require a local server.");
const errors = [];
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

  await context.route(`https://${project}.supabase.co/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/auth/v1/user")
      return route.fulfill({
        json: {
          id: uid,
          aud: "authenticated",
          role: "authenticated",
          email: "fixture@example.invalid",
        },
      });
    if (
      /\/rest\/v1\/(events|note_event_links|note_links|note_sources|note_revisions|note_import_batches)$/.test(
        url.pathname,
      )
    )
      return route.fulfill({ json: [] });
    return route.fulfill({
      status: 400,
      json: { message: "Unhandled fixture endpoint" },
    });
  });
  await context.route(`${base}/api/notes/ingest`, (route) =>
    route.fulfill({ json: { aiConfigured: false } }),
  );
  const notes = [
    {
      id: "50000000-0000-4000-8000-000000000011",
      title: "C4D 第一课",
      course: "C4D",
      lesson_date: "2026-10-19",
      body: "## 知识点\n对象 [[C4D 第二课]]",
      tags: ["C4D"],
      version: 1,
      updated_at: new Date().toISOString(),
    },
    {
      id: "50000000-0000-4000-8000-000000000012",
      title: "C4D 第二课",
      course: "C4D",
      lesson_date: "2026-10-26",
      body: "## 操作步骤\n材质",
      tags: ["C4D"],
      version: 1,
      updated_at: new Date().toISOString(),
    },
    {
      id: "50000000-0000-4000-8000-000000000013",
      title: "Coding 第一课",
      course: "Coding",
      lesson_date: null,
      body: "Functions",
      tags: [],
      version: 1,
      updated_at: new Date().toISOString(),
    },
  ];
  await context.route(
    `https://${project}.supabase.co/rest/v1/notes**`,
    async (route) => {
      const req = route.request(),
        url = new URL(req.url());
      if (req.method() === "PATCH") {
        const note = notes.find(
          (n) => n.id === url.searchParams.get("id")?.slice(3),
        );
        Object.assign(note, JSON.parse(req.postData()), {
          version: note.version + 1,
        });
        return route.fulfill({ json: note });
      }
      return route.fulfill({ json: notes });
    },
  );
  await context.route(
    `https://${project}.supabase.co/rest/v1/note_revisions**`,
    (r) => r.fulfill({ json: [] }),
  );
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${base}/notes`);
  await page.getByText("3篇独立笔记", { exact: true }).waitFor();
  await page.locator(".notes-library select").selectOption("C4D");
  await page.getByText("2篇独立笔记", { exact: true }).waitFor();
  await page.getByRole("button", { name: "C4D 第一课", exact: false }).click();
  await page
    .getByRole("button", { name: "C4D 第二课", exact: true })
    .first()
    .click();
  assert.equal(
    await page.getByLabel("标题", { exact: true }).inputValue(),
    "C4D 第二课",
  );
  await page.getByLabel("标题", { exact: true }).fill("C4D 第二课 · 材质");
  await page.getByRole("button", { name: "保存笔记", exact: true }).click();
  await page.getByText("笔记已保存，保留修改历史。", { exact: true }).waitFor();
  assert.equal(notes[1].version, 2);
  await page
    .getByRole("button", { name: "导入聊天 / 课堂笔记", exact: true })
    .click();
  await page.getByRole("button", { name: "收起导入", exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 2,
    ),
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      course_filter: true,
      independent_notes: true,
      wiki_navigation: true,
      versioned_save: true,
      collapsible_import: true,
      mobile_layout: true,
      page_errors: errors.length,
    }),
  );
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
