import { NextResponse } from "next/server";
import { adminDB, serverDB, sameOrigin } from "@/lib/server";
export const runtime = "nodejs";
export const maxDuration = 60;
export async function DELETE(req: Request) {
  if (!sameOrigin(req))
    return NextResponse.json({ error: "来源验证失败" }, { status: 403 });
  const session = await serverDB();
  const {
    data: { user },
  } = await session.auth.getUser();
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const body = await req.json().catch(() => null);
  if (body?.confirmation !== "永久删除我的账号")
    return NextResponse.json(
      { error: "请输入完整确认文字。" },
      { status: 400 },
    );
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY)
    return NextResponse.json(
      { error: "账号删除需要安全配置服务端凭据，当前未配置。" },
      { status: 503 },
    );
  const admin = adminDB();
  const verified = await admin.auth.admin.getUserById(user.id);
  if (verified.error || verified.data.user?.id !== user.id)
    return NextResponse.json(
      {
        error:
          "服务端权限验证失败，未删除任何文件或账号。请由项目管理员检查安全配置。",
      },
      { status: 503 },
    );
  let filesRemoved = false;
  try {
    const paths: string[] = [];
    const collect = async (prefix: string, depth = 0): Promise<void> => {
      if (depth > 5) throw Error("文件层级过深，未删除账号。");
      for (let offset = 0; ; offset += 100) {
        const r = await admin.storage
          .from("event-board")
          .list(prefix, {
            limit: 100,
            offset,
            sortBy: { column: "name", order: "asc" },
          });
        if (r.error) throw Error("附件清单无法读取，未删除账号。");
        for (const object of r.data || []) {
          if (
            !object.name ||
            object.name === "." ||
            object.name === ".." ||
            object.name.includes("/")
          )
            throw Error("附件路径异常。");
          const path = prefix + "/" + object.name;
          if (object.id) paths.push(path);
          else await collect(path, depth + 1);
          if (paths.length > 5000)
            throw Error("附件较多，请先分批清理，账号尚未删除。");
        }
        if ((r.data?.length || 0) < 100) break;
      }
    };
    await collect(user.id);
    for (let i = 0; i < paths.length; i += 50) {
      const r = await admin.storage
        .from("event-board")
        .remove(paths.slice(i, i + 50));
      if (r.error)
        throw Error("部分附件未能清理，账号尚未删除；请检查后重试。");
      filesRemoved = true;
    }
    const removed = await admin.auth.admin.deleteUser(user.id);
    if (removed.error)
      throw Error(
        filesRemoved
          ? "附件已永久清理，但账号删除未完成，请联系项目管理员处理剩余账号数据。"
          : "账号删除未完成，未清理账号数据。",
      );
    return NextResponse.json({
      message: "账号及其数据库内容已删除，附件已清理。",
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "删除失败，请核对后重试。" },
      { status: 502 },
    );
  }
}
