# 一次授权，自动部署通知后台

数据库迁移已经成功时，不要再次运行初始迁移，也不要在网页里逐个复制函数。本仓库新增的部署命令用 Supabase CLI **2.121.0**，直接使用当前项目 `flhwcojxhsyjpzfqxttx`。两个函数的共享源码和 import map 会一起打包，不依赖网页里的同目录改写。

## 推荐：GitHub Actions 安全授权

1. 在 [Supabase Account → Access Tokens](https://supabase.com/dashboard/account/tokens) 创建临时部署授权。它是 Management API 授权，不是数据库 service-role key，也不是 Telegram Bot token。选择覆盖项目管理、函数、Secrets 和数据库查询所需的权限；部署结束后可撤销。
2. 打开 [仓库 Settings → Secrets and variables → Actions](https://github.com/yinglin2705/OS/settings/secrets/actions)，点击 **New repository secret**。名称为 `SUPABASE_ACCESS_TOKEN`，值仅粘贴到这个 GitHub 安全输入框。不要发在聊天、Issue、日志或普通环境变量文件中。
3. 打开 [Deploy Supabase notifications](https://github.com/yinglin2705/OS/actions/workflows/deploy-notifications.yml)，点击 **Run workflow**，选择 `main` 与 `deploy`。任务内部先检查现状，再进行部署，无需复制 SQL 或函数代码。
4. 可选 `inspect` 只读检查，`verify` 只读验证部署状态与 webhook，不生成新密钥或触发通知发送。

此工作流需要你保存授权并启动后才会执行。推送代码、绿色本地测试或已保存环境草稿都不代表函数上线或真实消息送达。当前 Codex 云机器没有账号管理授权，且其网络代理阻断 Supabase 管理接口；GitHub 执行器可绕开这台机器的网络入口限制。

main 分支修改 `.github/workflows/deploy-notifications.yml` 时会自动执行 deploy；其他代码推送不会自动启动通知部署。`SUPABASE_HOME` 在 step 中由 `RUNNER_TEMP` 初始化并写入 `GITHUB_ENV`，不使用 job 级 runner context。工作流 Summary 提供不含密钥和 chat ID 的部署核查结果。

## 自动化流程做什么

- 读取函数列表、JWT 元数据、Secret **名称与摘要**、所需表/RPC、相关 Cron 和通知状态。不打印任何密钥或聊天 ID。
- 若 `TELEGRAM_BOT_TOKEN` 已保存在 Supabase，保留它；不会要求你再复制该 token。
- 创建缺少的 `TELEGRAM_WEBHOOK_SECRET` 与 `SCHEDULER_SECRET`，使用加密随机 32 字节；临时文件权限 600、目录权限 700，并在结束时清理。
- 已有 webhook secret 不轮换。已有 scheduler secret 与 Vault 摘要一致时复用；若无法一致核实，会停止而不是盲目覆盖。
- 启用缺少的 pg_cron、pg_net、Vault，安全同步两项 YING OS Vault 记录。不会重跑 `001_ying_os.sql`、删除活动或改动个人静音偏好。
- 依次 CLI 部署 `telegram-webhook` 和 `notification-worker`，明确带 `--no-verify-jwt --use-api --import-map supabase/functions/deno.json`，不使用 `--prune`，不删除其他函数。
- 核对两个函数为 ACTIVE / verify_jwt=false，再探测无授权请求是否被**应用自身**返回 401。JWT 网关关闭不等于没有认证：webhook 验证 Telegram header secret，worker 验证 scheduler bearer secret。
- 通过受 scheduler secret 保护的 worker 管理动作注册 webhook。Bot token 只留在 Edge runtime。先读取 getWebhookInfo；如果当前 bot 指向另一个集成，会停止，不擅自覆盖。不会丢弃已有 Telegram 更新。
- Cron 使用 Vault 引用，不内嵌密钥。重用现有同一 worker 的任务；保留一个每分钟任务，停用同目标的重复任务，其他任务不变。事务 advisory lock 避免 SQL 阶段并发创建。
- 初次运行 worker 并显示聚合通知状态。0 条发送只代表暂时没有可发送队列，不是端到端通过。

已有 `SCHEDULER_SECRET` 无法匹配 Vault 时：在 GitHub Actions 同一安全设置中添加该值为可选 secret `SCHEDULER_SECRET`，再运行 deploy；脚本会核对摘要。无需在聊天发送，也不会自动轮换现有值。

## 也可在你自己的电脑用 CLI

本地终端的浏览器登录只授权你自己的电脑，不会把授权传到 Codex 云机器。

```bash
git clone https://github.com/yinglin2705/OS.git
cd OS
npm run deploy:notifications
```

已克隆仓库时先 `git pull --ff-only`。需要 Node.js 22+ / npm；这个部署命令会通过 npm 安装固定版本的 CLI，不要求 Docker或数据库密码。没有授权时会打开 Supabase 浏览器登录，验证码**只输入同一个本地终端**。CLI 使用原生凭据存储；不可用时使用专用临时目录 SUPABASE_HOME 的凭据文件，绝不会放入源码。

```bash
npm run deploy:notifications -- --inspect
npm run deploy:notifications -- --verify
```

只读模式要求已有 CLI 登录；可先运行 `npm exec --yes --package=supabase@2.121.0 -- supabase login`，或直接执行默认部署命令完成浏览器授权。不要同时开启多次本地部署；Actions 已配置项目级并发互斥。

## 验证实际消息

1. workflow 的 deploy 步骤成功后，打开已经部署的网站 → **设置与通知 → 连接 Telegram**。
2. 将应用生成的一次性代码发送到 workflow 日志中显示的 bot 私聊；只在 Telegram 发送绑定码，不在公开日志或聊天分享它。
3. 等待下一次分钟任务。若在静音时段，通知会延期到静音结束；测试消息同样遵守该偏好，不自动绕过。
4. 必须在 Telegram 真实收到测试消息，并在应用通知历史看到 `sent` / `delivered_at`，才能确认通路成功。
5. 再批准一条自己的准备提醒，将它设为几分钟后，关闭网页，核实仍收到消息。之后检查实际 07:00、22:00 与周日 19:00 的 London 简报。

`verify` 会检查 webhook、任务数量和聚合 delivered_at，但不会伪造一条送达记录。CLI 不会自动创建你的 Telegram 绑定、发送未经授权的外部聊天消息或使用虚构账号作测试。

## 当前验证证据

规则和管理动作测试、模拟 CLI/HTTP 的整条部署流程、真实 PostgreSQL 迁移验证及 Cron API stub 重复执行测试已覆盖。stub 测试验证重用、去重、保留其他任务与不内嵌密钥，但**不等于托管 pg_cron/pg_net/Vault 已验证**。真实托管状态与真实 Telegram 送达仍须授权后检查。
