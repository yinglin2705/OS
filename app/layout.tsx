import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "YING OS · 我的学术与创作日历",
  description: "有来源、可核实的个人学术与创作日历",
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
