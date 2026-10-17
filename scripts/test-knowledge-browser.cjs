const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const uid = "00000000-0000-4000-8000-000000000011",
  eid = "20000000-0000-4000-8000-000000000011",
  eid2 = "20000000-0000-4000-8000-000000000012";
const project = new URL(
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
    "https://flhwcojxhsyjpzfqxttx.supabase.co",
).hostname.split(".")[0];
const cards = [
  {
    id: "30000000-0000-4000-8000-000000000011",
    event_id: eid,
    user_id: uid,
    kind: "note",
    title: "研究想法",
    body: "[[演示活动]]\n观察人与空间的互动。",
    url: null,
    image_path: null,
    original_filename: null,
    color: "yellow",
    x: 40,
    y: 70,
  },
  {
    id: "30000000-0000-4000-8000-000000000012",
    event_id: eid,
    user_id: uid,
    kind: "image",
    title: "参考照片",
    body: "图片下方的观察笔记。",
    url: null,
    image_path: `${uid}/${eid}/sample.png`,
    original_filename: "sample.png",
    color: "yellow",
    x: 390,
    y: 100,
  },
];
const events = [
  {
    id: eid,
    title: "演示活动",
    description: "空间研究",
    notes: "",
    location: "Studio",
    course: "",
    preparation: "",
    start_at: null,
  },
  {
    id: eid2,
    title: "另一个项目",
    description: "空间研究",
    notes: "",
    location: "",
    course: "",
    preparation: "",
    start_at: null,
  },
];
const base = process.env.YING_BROWSER_BASE_URL || "http://localhost:3078";
if (!["localhost", "127.0.0.1"].includes(new URL(base).hostname)) {
  throw Error("Browser fixtures may only run against a local server.");
}
const links = [];
const errors = [];
let pdfUploaded = false;
let downloads = 0;
(async () => {
  const browser = await chromium.launch({
    executablePath:
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox"],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    acceptDownloads: true,
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
    const req = route.request(),
      u = new URL(req.url()),
      method = req.method();
    let data;
    if (u.pathname === "/auth/v1/user")
      data = {
        id: uid,
        aud: "authenticated",
        role: "authenticated",
        email: "fixture@example.invalid",
      };
    else if (
      u.pathname.includes("/storage/v1/object/sign/") &&
      method === "POST"
    )
      data = {
        signedURL: "/object/sign/event-board/mock.png?token=local-only",
      };
    else if (u.pathname.includes("/storage/v1/object/") && method === "POST") {
      pdfUploaded =
        req.headers()["content-type"] === "application/pdf" ||
        !!req.postDataBuffer()?.includes(Buffer.from("application/pdf"));
      data = { Key: "fixture" };
    } else if (u.pathname.includes("/storage/v1/object/"))
      return route.fulfill({
        status: 200,
        contentType: "image/png",
        body: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
          "base64",
        ),
      });
    else if (u.pathname.endsWith("/rest/v1/rpc/search_knowledge")) {
      const q = JSON.parse(req.postData()).search_text;
      data = events
        .filter((e) => (e.title + e.description).includes(q))
        .map((e) => ({
          node_id: "event:" + e.id,
          event_id: e.id,
          card_id: null,
          title: e.title,
          excerpt: e.description,
          kind: "event",
          start_at: null,
        }));
    } else if (u.pathname.endsWith("/rest/v1/events")) {
      data = u.searchParams.get("id") ? events[0] : events;
    } else if (u.pathname.endsWith("/rest/v1/event_board_cards")) {
      if (method === "POST") {
        const r = JSON.parse(req.postData());
        cards.push({ id: crypto.randomUUID(), ...r });
        data = null;
      } else if (method === "PATCH") {
        const id = u.searchParams.get("id").slice(3);
        const c = cards.find((c) => c.id === id);
        Object.assign(c, JSON.parse(req.postData()));
        data = { id };
      } else data = cards;
    } else if (u.pathname.endsWith("/rest/v1/event_board_edges")) data = [];
    else if (u.pathname.endsWith("/rest/v1/knowledge_links")) {
      if (method === "POST")
        links.push({ id: crypto.randomUUID(), ...JSON.parse(req.postData()) });
      data = method === "POST" ? null : links;
    } else
      return route.fulfill({
        status: 400,
        json: { message: "Unhandled fixture endpoint" },
      });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(data),
    });
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${base}/events/${eid}/board`);
  await page.getByRole("button", { name: "＋ 便签", exact: true }).waitFor();
  assert.equal(await page.locator("#board-composer").count(), 0);
  await page.locator(".board-note").waitFor();
  assert.equal(await page.locator(".board-note").count(), 1);
  assert.equal(await page.locator(".board-image img").count(), 1);
  await page.waitForFunction(
    () => document.querySelector(".board-image img")?.naturalWidth > 0,
  );
  const vh = await page
    .locator(".board-viewport")
    .evaluate((el) => el.clientHeight);
  assert(vh > 650);
  for (let i = 0; i < 5; i++)
    await page.getByRole("button", { name: "缩小看板", exact: true }).click();
  await page
    .getByRole("button", { name: "重置缩放" })
    .getByText("50%")
    .waitFor();
  const handle = page.getByRole("button", {
    name: "拖动卡片1，或用方向键移动",
    exact: true,
  });
  const p = await handle.boundingBox();
  await page.mouse.move(p.x + p.width / 2, p.y + p.height / 2);
  await page.mouse.down();
  await page.mouse.move(p.x + p.width / 2 + 50, p.y + p.height / 2 + 30, {
    steps: 8,
  });
  await page.mouse.up();
  await page.waitForFunction(
    () => !document.querySelector(".board-drag").disabled,
  );
  assert.equal(cards[0].x, 140);
  assert.equal(cards[0].y, 130);
  await page.getByRole("button", { name: "＋ PDF", exact: true }).click();
  await page.getByLabel("标题", { exact: true }).fill("阅读资料");
  await page.getByLabel("摘要 / 阅读笔记").fill("空间研究笔记");
  await page
    .locator("input[type=file]")
    .setInputFiles({
      name: "reading.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4\nlocal-fixture"),
    });
  await page.getByRole("button", { name: "放到看板上", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector("#board-composer"));
  assert(pdfUploaded);
  assert.equal(cards.at(-1).kind, "pdf");
  assert.equal(cards.at(-1).original_filename, "reading.pdf");
  await page.getByRole("button", { name: "适应内容", exact: true }).click();
  await page.waitForTimeout(100);
  await page.screenshot({ path: "/tmp/ying-board-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await page.screenshot({ path: "/tmp/ying-board-mobile.png" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${base}/search`);
  await page.getByRole("button", { name: "搜索", exact: true }).waitFor();
  await page.getByRole("searchbox").fill("演示");
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await page
    .getByRole("heading", { name: "搜索结果 · 1", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "作为关联起点", exact: true }).click();
  await page.getByRole("searchbox").fill("另一个");
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await page.getByRole("button", { name: "连接到这里", exact: true }).click();
  await page.getByText("关联已保存，可在关系图和导出文件中查看。").waitFor();
  assert.equal(links.length, 1);
  const dl = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "导出到 Obsidian / Markdown", exact: true })
    .click();
  const download = await dl;
  assert.equal(download.suggestedFilename(), "YING-OS-private-vault.zip");
  downloads++;
  await page.screenshot({ path: "/tmp/ying-search-desktop.png" });
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      board_drawer: true,
      sticky_notes: true,
      image_caption: true,
      zoom_drag: true,
      pdf_upload: true,
      mobile_layout: true,
      cross_query_link: true,
      markdown_zip_downloads: downloads,
      page_errors: errors.length,
    }),
  );
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
