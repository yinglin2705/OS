const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const uid = "00000000-0000-4000-8000-000000000081",
  eid = "20000000-0000-4000-8000-000000000081";
const project = new URL(
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
    "https://flhwcojxhsyjpzfqxttx.supabase.co",
).hostname.split(".")[0];
const base = process.env.YING_BROWSER_BASE_URL || "http://localhost:3112";
if (!["localhost", "127.0.0.1"].includes(new URL(base).hostname))
  throw Error("Local fixtures only");
(async () => {
  const browser = await chromium.launch({
    executablePath: "/usr/bin/chromium",
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

  const events = [
    {
      id: "20000000-0000-4000-8000-000000000082",
      title: "Unknown-time fixture",
      start_at: null,
      end_at: null,
      deadline_at: null,
      category: "academic",
      status: "planned",
      version: 1,
      event_sources: [],
      timezone: "Europe/London",
    },
  ];
  const proposals = [
    {
      id: "40000000-0000-4000-8000-000000000081",
      event_id: null,
      payload: {
        title: "Robotic fixture",
        category: "technical",
        start_at: "2031-04-07T13:00:00Z",
        end_at: "2031-04-07T13:30:00Z",
        deadline_at: null,
        status: "planned",
        timezone: "Europe/London",
      },
      warnings: [],
      source: { source_type: "fixture" },
      created_at: new Date().toISOString(),
    },
  ];
  let failReadback = false;
  const errors = [];
  await context.route(`https://${project}.supabase.co/**`, async (route) => {
    const u = new URL(route.request().url()),
      path = u.pathname;
    if (path === "/auth/v1/user")
      return route.fulfill({
        json: {
          id: uid,
          aud: "authenticated",
          role: "authenticated",
          email: "fixture@example.invalid",
        },
      });
    if (path.endsWith("/rpc/confirm_proposal")) {
      events.push({
        id: eid,
        ...proposals[0].payload,
        version: 1,
        event_sources: [],
      });
      proposals.splice(0, 1);
      return route.fulfill({ json: eid });
    }
    if (path.endsWith("/rpc/set_event_status")) {
      const b = route.request().postDataJSON(),
        e = events.find((e) => e.id === b.target);
      assert.equal(e.version, b.expected_version);
      e.status = b.new_status;
      e.version++;
      return route.fulfill({ json: e.id });
    }
    if (path.endsWith("/events")) {
      if (u.searchParams.has("id")) {
        if (failReadback)
          return route.fulfill({
            status: 503,
            json: { message: "fixture readback unavailable" },
          });
        return route.fulfill({
          json: events.filter((e) => u.searchParams.get("id").includes(e.id)),
        });
      }
      return route.fulfill({ json: events });
    }
    if (path.endsWith("/change_proposals"))
      return route.fulfill({ json: proposals });
    if (path.endsWith("/preparation_tasks")) return route.fulfill({ json: [] });
    if (path.endsWith("/event_status_history"))
      return route.fulfill({
        status: 400,
        json: { message: "fixture history unavailable" },
      });
    if (path.endsWith("/users"))
      return route.fulfill({ json: { timezone: "Europe/London" } });
    throw Error("Unexpected fixture endpoint");
  });
  let directWrites = 0;
  await context.route(`${base}/api/ingest`, async (route) => {
    const body = route.request().postDataJSON();
    directWrites++;
    const id = "20000000-0000-4000-8000-000000000083";
    events.push({ ...body.event, id, version: 1, event_sources: [] });
    return route.fulfill({
      json: { count: 1, event_ids: [id], message: "已直接写入日历" },
    });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base);
  await page.getByText(/已保存日程 1 条/).waitFor();
  await page
    .getByRole("alert")
    .getByText(/日历已读取/)
    .waitFor();
  await page.locator(".calendar-unscheduled summary").click();
  await page
    .locator(".calendar-unscheduled")
    .getByRole("button", { name: /Unknown-time fixture/ })
    .waitFor();
  await page.getByRole("button", { name: /AI 收件箱/ }).click();
  await page.getByRole("button", { name: "确认更改", exact: true }).click();
  await page.getByRole("dialog", { name: "活动详情" }).waitFor();
  await page
    .getByRole("heading", { name: "Robotic fixture", exact: true })
    .waitFor();
  await page.getByText("2031-04-07 14:00", { exact: true }).waitFor();
  await page
    .getByRole("group", { name: "行程状态", exact: true })
    .getByRole("button", { name: "确认", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "活动详情" })
    .getByText("已保存 · 原来源与历史保留", { exact: true })
    .waitFor();
  assert.equal(events.find((e) => e.id === eid).status, "confirmed");
  assert.equal(
    await page
      .getByRole("group", { name: "行程状态", exact: true })
      .getByRole("button")
      .count(),
    4,
  );
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page
    .locator(".day-hours")
    .getByRole("button", { name: /Robotic fixture/ })
    .waitFor();
  await page.getByLabel("搜索行程", { exact: true }).fill("robotic");
  assert.equal(await page.locator(".agenda .event-card").count(), 1);
  assert(
    (await page.locator(".agenda").innerText()).includes("Robotic fixture"),
  );
  await page.getByRole("button", { name: "全部已保存", exact: true }).click();
  assert.equal(await page.locator(".agenda .event-card").count(), 2);
  await page
    .locator(".agenda")
    .getByRole("button", { name: /Robotic fixture/ })
    .click();
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: /新建活动/ }).click();
  await page
    .getByRole("dialog", { name: "编辑活动" })
    .getByLabel("活动名称", { exact: true })
    .fill("Direct write fixture");
  await page.getByRole("button", { name: "保存到日历", exact: true }).click();
  await page
    .getByRole("heading", { name: "Direct write fixture", exact: true })
    .waitFor();
  assert.equal(directWrites, 1);
  assert.equal(proposals.length, 0);
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "全部已保存", exact: true }).click();
  await page
    .locator(".agenda")
    .getByRole("button", { name: /Robotic fixture/ })
    .click();
  failReadback = true;
  await page
    .getByRole("group", { name: "行程状态", exact: true })
    .getByRole("button", { name: "取消", exact: true })
    .click();
  await page
    .getByText("结果尚未回读确认，请刷新核对。", { exact: true })
    .waitFor();
  assert.equal(events.find((e) => e.id === eid).status, "cancelled");
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      metadata_failure_does_not_hide_events: true,
      confirmed_readback: true,
      confirmed_date_navigation: true,
      unknown_time_records_visible: true,
      direct_status_update: true,
      search_saved_events: true,
      all_saved_clears_filters: true,
      readback_failure_not_claimed_success: true,
      page_errors: 0,
    }),
  );
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
