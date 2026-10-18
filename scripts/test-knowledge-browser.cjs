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
const boardEdges = [],
  highlights = [];
function pdfFixture() {
  const content = (n) => `BT /F1 24 Tf 40 500 Td (Page ${n}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 560] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${content(1).length} >>\nstream\n${content(1)}\nendstream`,
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 560] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>",
    `<< /Length ${content(2).length} >>\nstream\n${content(2)}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let data = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(data));
    data += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = Buffer.byteLength(data);
  data +=
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets
      .slice(1)
      .map((o) => String(o).padStart(10, "0") + " 00000 n \n")
      .join("") +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(data);
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
        signedURL: `/object/sign/event-board/mock.${u.pathname.endsWith(".pdf") ? "pdf" : "png"}?token=local-only`,
      };
    else if (u.pathname.includes("/storage/v1/object/") && method === "POST") {
      pdfUploaded =
        req.headers()["content-type"] === "application/pdf" ||
        !!req.postDataBuffer()?.includes(Buffer.from("application/pdf"));
      data = { Key: "fixture" };
    } else if (
      u.pathname.includes("/storage/v1/object/") &&
      u.pathname.endsWith(".pdf")
    )
      return route.fulfill({
        status: 200,
        contentType: "application/pdf",
        body: pdfFixture(),
      });
    else if (u.pathname.includes("/storage/v1/object/"))
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
    } else if (u.pathname.endsWith("/rest/v1/rpc/connect_board_cards")) {
      const { source_card: a, target_card: b } = JSON.parse(req.postData());
      let edge = boardEdges.find(
        (e) => [a, b].includes(e.from_card) && [a, b].includes(e.to_card),
      );
      if (!edge) {
        edge = { id: crypto.randomUUID(), from_card: a, to_card: b };
        boardEdges.push(edge);
      }
      data = edge.id;
    } else if (u.pathname.endsWith("/rest/v1/rpc/create_linked_board_note")) {
      const r = JSON.parse(req.postData());
      const id = crypto.randomUUID();
      cards.push({
        id,
        event_id: eid,
        user_id: uid,
        kind: "note",
        title: r.note_title,
        body: r.note_body,
        color: r.note_color,
        x: r.position_x,
        y: r.position_y,
        display_width: 270,
        pdf_page: 1,
        url: null,
        image_path: null,
      });
      boardEdges.push({
        id: crypto.randomUUID(),
        from_card: r.source_card,
        to_card: id,
      });
      data = id;
    } else if (u.pathname.endsWith("/rest/v1/board_highlights")) {
      if (method === "POST") {
        const r = { id: crypto.randomUUID(), ...JSON.parse(req.postData()) };
        highlights.push(r);
        data = r;
      } else if (method === "DELETE") {
        const i = highlights.findIndex(
          (h) => h.id === u.searchParams.get("id")?.slice(3),
        );
        if (i >= 0) highlights.splice(i, 1);
        data = null;
      } else
        data = u.searchParams.has("card_id")
          ? highlights.filter(
              (h) =>
                h.card_id === u.searchParams.get("card_id")?.slice(3) &&
                h.page === Number(u.searchParams.get("page")?.slice(3)),
            )
          : highlights;
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
    } else if (u.pathname.endsWith("/rest/v1/event_board_edges"))
      data = boardEdges;
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
  page.setDefaultTimeout(15000);
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
  await page.locator("input[type=file]").setInputFiles({
    name: "reading.pdf",
    mimeType: "application/pdf",
    buffer: pdfFixture(),
  });
  await page.getByRole("button", { name: "放到看板上", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector("#board-composer"));
  assert(pdfUploaded);
  assert.equal(cards.at(-1).kind, "pdf");
  assert.equal(cards.at(-1).original_filename, "reading.pdf");
  await page.getByText("1 / 2", { exact: true }).waitFor();
  await page.waitForFunction(
    () => document.querySelector(".pdf-page-canvas")?.width > 400,
  );
  console.log("PDF rendered in local worker.");
  const note = page.locator(".board-note").first(),
    image = page.locator(".board-image"),
    pdf = page.locator(".board-pdf");
  async function stroke(locator) {
    const svg = locator.locator(".highlight-overlay");
    const rect = await svg.boundingBox();
    await page.mouse.move(
      rect.x + rect.width * 0.2,
      rect.y + rect.height * 0.4,
    );
    await page.mouse.down();
    await page.mouse.move(
      rect.x + rect.width * 0.8,
      rect.y + rect.height * 0.4,
      { steps: 8 },
    );
    await page.mouse.up();
    await page.waitForFunction(
      () =>
        !Array.from(document.querySelectorAll(".annotation-tools")).some((e) =>
          e.textContent.includes("保存中"),
        ),
    );
  }
  await note.getByRole("button", { name: "荧光笔", exact: true }).click();
  await stroke(note);
  console.log("Note highlight saved.");
  assert.equal(highlights.length, 1);
  assert.equal(highlights[0].page, 0);
  assert(Math.abs(highlights[0].points[0][0] - 0.2) < 0.02);
  await image.getByRole("button", { name: "荧光笔", exact: true }).click();
  await stroke(image);
  assert.equal(highlights.length, 2);
  const oldPath = await image
    .locator(".highlight-overlay path")
    .getAttribute("d");
  const resize = page.getByRole("button", {
    name: "等比调整卡片2大小",
    exact: true,
  });
  const rb = await resize.boundingBox();
  await page.mouse.move(rb.x + rb.width / 2, rb.y + rb.height / 2);
  await page.mouse.down();
  await page.mouse.move(rb.x + rb.width / 2 + 50, rb.y + rb.height / 2, {
    steps: 6,
  });
  await page.mouse.up();
  await page.waitForFunction(
    () => !document.querySelector(".board-drag").disabled,
  );
  assert.equal(cards[1].display_width, 440);
  assert(
    await page
      .locator(".board-image img")
      .evaluate(
        (img) =>
          Math.abs(
            img.clientWidth / img.clientHeight -
              img.naturalWidth / img.naturalHeight,
          ) < 0.01,
      ),
  );
  assert.equal(
    await image.locator(".highlight-overlay path").getAttribute("d"),
    oldPath,
  );
  await pdf.getByRole("button", { name: "荧光笔", exact: true }).click();
  await stroke(pdf);
  assert.equal(highlights.at(-1).page, 1);
  await page.getByRole("button", { name: "PDF 下一页", exact: true }).click();
  await page.getByText("2 / 2", { exact: true }).waitFor();
  await page.waitForFunction(
    () => !document.querySelector(".board-drag").disabled,
  );
  await page.waitForFunction(
    () =>
      document.querySelector(".board-pdf .annotation-tools button")
        ?.textContent === "退出荧光笔",
  );
  assert.equal(await pdf.locator(".highlight-overlay path").count(), 0);
  await stroke(pdf);
  assert.equal(highlights.at(-1).page, 2);
  await page.getByRole("button", { name: "PDF 上一页", exact: true }).click();
  await page.getByText("1 / 2", { exact: true }).waitFor();
  await page.waitForFunction(() =>
    document.querySelector(".board-pdf .highlight-overlay path"),
  );
  assert.equal(await pdf.locator(".highlight-overlay path").count(), 1);
  await pdf.getByRole("button", { name: "退出荧光笔", exact: true }).click();
  async function linkDrag(source, target, hold = true) {
    const a = await source.boundingBox(),
      b = await target.boundingBox();
    await page.mouse.move(a.x + a.width * 0.3, a.y + a.height * 0.5);
    await page.mouse.down();
    if (hold) await page.waitForTimeout(520);
    await page.mouse.move(b.x + b.width * 0.5, b.y + b.height * 0.5, {
      steps: 12,
    });
    await page.mouse.up();
    await page.waitForFunction(
      () => !document.querySelector(".board-drag").disabled,
    );
  }
  await linkDrag(
    note.locator(".board-card-content"),
    image.locator(".board-photo"),
  );
  console.log("Drag link response verified.");
  assert.equal(boardEdges.length, 1);
  await linkDrag(
    image.locator(".board-photo"),
    note.locator(".board-card-content"),
  );
  console.log("Drag link response verified.");
  assert.equal(boardEdges.length, 1);
  const a = await note.locator(".board-card-content").boundingBox(),
    vp = await page.locator(".board-viewport").boundingBox();
  await page.mouse.move(a.x + 30, a.y + 30);
  await page.mouse.down();
  await page.waitForTimeout(520);
  await page.mouse.move(vp.x + vp.width - 80, vp.y + vp.height - 80, {
    steps: 12,
  });
  await page.mouse.up();
  await page.locator("#board-composer").waitFor();
  const before = cards.length;
  await page.getByLabel("标题", { exact: true }).fill("拖出新便签");
  await page.getByRole("button", { name: "放到看板上", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector("#board-composer"));
  assert.equal(cards.length, before + 1);
  assert.equal(boardEdges.length, 2);
  const cancelCount = cards.length;
  const ca = await note.locator(".board-card-content").boundingBox();
  await page.mouse.move(ca.x + 30, ca.y + 30);
  await page.mouse.down();
  await page.waitForTimeout(520);
  await page.mouse.move(vp.x + vp.width - 200, vp.y + 150, {
    steps: 10,
  });
  await page.mouse.up();
  await page.getByRole("button", { name: "取消新建", exact: true }).click();
  assert.equal(cards.length, cancelCount);
  assert.equal(boardEdges.length, 2);
  await page.reload();
  await page.getByText("1 / 2", { exact: true }).waitFor();
  await page
    .locator(".board-note .highlight-overlay path")
    .first()
    .waitFor({ state: "attached" });
  assert.equal(
    await page.locator(".board-wires path:not(.board-wire-preview)").count(),
    2,
  );
  assert.equal(cards[1].display_width, 440);
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
      long_press_link: true,
      reverse_link_dedup: true,
      blank_drop_linked_note: true,
      pdf_render_and_paging: true,
      highlight_page_isolation: true,
      highlight_reload: true,
      aspect_resize: true,
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
