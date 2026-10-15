# Telegram 通知后台交接记录

核验时间：2026-10-15 00:00 UTC（Europe/London 01:00）。

## 已完成

- 修复 GitHub Actions job 级 `runner.temp` 表达式：在 step 中使用 `RUNNER_TEMP`，通过 `GITHUB_ENV` 设置 CLI 私有目录。
- 修复部署查询依赖不可达 IPv6 数据库连接的问题：CI 使用 Supabase HTTPS Management API；函数部署仍使用官方 CLI。
- 从仓库重新部署 `telegram-webhook` 和 `notification-worker`，均为 `ACTIVE`、`verify_jwt=false`；应用层 webhook secret / scheduler secret 验证保留，未授权请求返回 401。
- 核验 Telegram webhook 指向本项目，机器人为 `ying_os_calendar_bot`，pending updates 为 0，无 webhook 最近错误记录。
- 配置缺失的后台机密并保留已有 Bot token；机密不进入源码、报告或客户端。
- Cron 只有一个启用任务 `ying-os-every-minute`，表达式 `* * * * *`；重复部署复用任务。
- 真实 Cron 执行最近成功时间为 00:00 UTC，最近 15 分钟失败数为 0；23:58、23:59、00:00 UTC 三次后台 HTTP 请求均返回 200、未超时。
- 绑定解析支持粘贴时的外围空白、大小写及 `/start@bot_name CODE`，保留短时有效、单次使用和私聊验证。新增仅记录结果类型的安全日志，不记录绑定码、聊天 ID 或消息内容。

部署代码：`4ded853fb95a6d033b5da5661111f1ef0c1260b7`。

[最新部署成功记录和安全检查结果](https://github.com/yinglin2705/OS/actions/runs/38657394379)

## 验证与未通过部分

- 自动化测试 52 项通过；两个 Edge Functions 的 Deno 类型检查及 Actions 工作流语法检查通过。
- 数据库核验：已绑定账号 0；已消费绑定码 0；当前有效码 0、过期码 3。`consume_link` 尚无真实成功记录，不能认定绑定链路已端到端通过。
- 通知队列 pending / failed / uncertain 均为 0；worker 返回 claimed=0、sent=0。成功送达记录为 0，本轮未发送测试消息。
- Supabase 请求日志查询返回平台错误 `Backend error! Retry your query. Please contact support if this continues.`，无法确认此前用户消息的具体 HTTP 请求结果。部署、当前 webhook 状态及 Cron 响应已通过独立检查；不据此推断旧消息已成功消费。
- 未改动现有活动、账号数据或静音设置；未延长绑定码有效期，未绕过账号授权，未重复创建 Cron。

## 明天最少需要做什么

在 YING OS 设置中点击「Connect Telegram」生成一个新码，立即私聊发送给 [@ying_os_calendar_bot](https://t.me/ying_os_calendar_bot)，再刷新连接状态。旧码已过期，无法安全代替用户完成此步骤。

之后需核验连接状态、`consume_link` 成功记录及真实 Telegram 消息送达；静音时段继续遵守现有设置。目前只能确认后台部署及分钟调度正常，不能宣称通知已端到端送达。
