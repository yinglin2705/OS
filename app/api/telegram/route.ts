import { randomBytes, createHash } from "node:crypto";
import { adminDB, serverDB, sameOrigin } from "@/lib/server";
import { NextResponse } from "next/server";
export async function POST(req: Request) {
  if (!sameOrigin(req))
    return NextResponse.json({ error: "来源验证失败" }, { status: 403 });
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY)
    return NextResponse.json(
      { error: "Supabase 服务端密钥尚未配置" },
      { status: 503 },
    );
  const {
    data: { user },
  } = await (await serverDB()).auth.getUser();
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const action = (await req.json()).action;
  const db = adminDB();
  if (action === "test") {
    const { data } = await db
      .from("telegram_connections")
      .select("user_id")
      .eq("user_id", user.id)
      .maybeSingle();
    if (!data)
      return NextResponse.json({ error: "请先连接 Telegram" }, { status: 400 });
    const minute = Math.floor(Date.now() / 60000);
    const { error } = await db
      .from("notification_deliveries")
      .upsert(
        {
          user_id: user.id,
          idempotency_key: `test:${user.id}:${minute}`,
          kind: "test",
          scheduled_at: new Date().toISOString(),
        },
        { onConflict: "idempotency_key", ignoreDuplicates: true },
      );
    return NextResponse.json(
      error
        ? { error: "无法加入通知队列" }
        : {
            message:
              "测试已排队；Cron 启用后发送，静音时段内会延迟。只有历史显示已送达才算成功。",
          },
      { status: error ? 500 : 200 },
    );
  }
  if (action === "disconnect") {
    const { error } = await db
      .from("telegram_connections")
      .delete()
      .eq("user_id", user.id);
    await db.from("telegram_link_codes").delete().eq("user_id", user.id);
    return NextResponse.json(
      error ? { error: "断开失败" } : { message: "已断开 Telegram" },
      { status: error ? 500 : 200 },
    );
  }
  if (action !== "link")
    return NextResponse.json({ error: "无效操作" }, { status: 400 });
  const { count } = await db
    .from("telegram_link_codes")
    .select("*", { count: "exact", head: true })
    .eq("user_id", user.id)
    .gt("expires_at", new Date().toISOString());
  if ((count || 0) >= 5)
    return NextResponse.json(
      { error: "请求过多，请十分钟后重试" },
      { status: 429 },
    );
  const code = "YING-" + randomBytes(12).toString("hex").toUpperCase();
  const expires = new Date(Date.now() + 10 * 60000).toISOString();
  const { error } = await db
    .from("telegram_link_codes")
    .insert({
      user_id: user.id,
      code_hash: createHash("sha256").update(code).digest("hex"),
      expires_at: expires,
    });
  if (error)
    return NextResponse.json({ error: "无法生成绑定码" }, { status: 500 });
  return NextResponse.json({
    code,
    expires,
    message: "在你创建的机器人私聊中发送此代码。十分钟有效，只能使用一次。",
  });
}
