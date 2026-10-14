import { serverDB } from "@/lib/server";
import { NextResponse } from "next/server";
export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  if (code) {
    const { error } = await (
      await serverDB()
    ).auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL("/", url));
  }
  return NextResponse.redirect(new URL("/?auth_error=1", url));
}
