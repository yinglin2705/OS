# YING OS

中文优先的学术与创作日历。Next.js / TypeScript / Tailwind、Supabase PostgreSQL 与认证、Supabase Cron / Edge Functions、Telegram 私聊通知。数据库是唯一权威存储，所有外部信息先进入用户确认队列。没有内置虚构 DFPI 时间表。

## 当前实现与限制

| 能力                                                     | 实现状态                                                             |
| -------------------------------------------------------- | -------------------------------------------------------------------- |
| 周 / 日 / 月 / 列表日历，类别过滤、深浅色、移动布局      | 已实现；需要 Supabase 才能读取真实用户数据                           |
| 邮箱 Magic Link 登录、本人数据 RLS                       | 已实现；需要配置 Supabase Auth 与邮件服务                            |
| 活动新增 / 编辑 / 状态、独立截止时间、来源、版本历史     | 已实现；确认提议后事务保存                                           |
| CSV / Excel 多工作表 / ICS / ChatGPT JSON / 对话片段导入 | 已实现；未知时间保留待核实，复杂 Excel 布局须适配表头                |
| 自然语言与去重                                           | 可解释规则实现；不是完整 LLM 语义理解，复杂消息需人工核实            |
| 重叠、必修、截止与交通间隔冲突                           | 已实现；45 分钟交通阈值是建议，未接地图计算                          |
| 自动准备任务和持久提醒建议                               | 已实现；按截止、优先级、演示、工作坊和交通上下文生成，用户批准后发送 |
| Telegram 单次绑定、测试队列、断开重连、设置与历史        | 已实现；真实 Bot / webhook / Cron 需部署配置                         |
| 每日 07:00 / 22:00，周日 19:00，DST、静音与去重          | 后端已实现；尚未向真实 Telegram 发送，没有宣称已启用                 |
| Google Calendar                                          | 支持导出 ICS 后导入；OAuth 双向同步未实现                            |
| 邮件 / Push / 其他渠道发送                               | 未实现；当前通知处理器使用 Telegram，队列可扩展其他适配器            |
| 重复活动                                                 | 保存重复标志和原始规则；尚未自动展开或发送重复实例提醒               |
| 附件                                                     | 模型可存链接；没有文件上传 / 私有 Storage 管理界面                   |
| 初始 DFPI Excel 迁移                                     | 待你上传真实文件；未猜测 Group A 时间或预约状态                      |

来源最后核实时间没有被导入或用户点击“确认”伪造成已核实。来源备注与原始记录会保留。导入的单纯截止日期不会成为该日上课活动；第一志愿 / applied 不会变成 booked。

## 本地开发

Node.js 22+。在现有 checkout `/workspace/OS` 工作，不需要新建 worktree。

```bash
npm ci --cache /tmp/ying-npm-cache
cp .env.example .env.local
# 在本地安全编辑 .env.local，勿提交真实凭据
npm run dev
```

未配置数据库时，首页显示真实配置提示；不会展示伪造日历。运行时无需另启应用内定时器，浏览器关闭不影响部署后的 Supabase Cron。

```bash
npm test                 # 规则、DST、冲突、消息和真实文件解析测试
npm run typecheck
npm run test:db          # Docker PostgreSQL 17：SQL 迁移、RLS、来源、版本、准备队列、去重与租约
npm run build
npm start
```

`test:db` 创建并清理自己专用的临时容器；不是生产数据库。CI 执行上述检查。数据库测试使用最小 auth schema 模拟 Supabase 的 auth.uid，并执行真实 PostgreSQL 事务；不代表托管 Auth / Edge / Telegram 已完成端到端验证。

## 部署到 Supabase 与 Vercel

**通知后台已新增一次授权的自动部署流程**：[自动部署说明](docs/NOTIFICATION_DEPLOYMENT.md)。迁移已成功时直接使用该流程，不必再次执行迁移或手工复制函数。

1. **创建 Supabase 项目**。在 SQL Editor 执行 `supabase/migrations/001_ying_os.sql` 一次，或使用已登录的 Supabase CLI：

   ```bash
   npx supabase link --project-ref YOUR_PROJECT_REF
   npx supabase db push
   ```

   不要在已有其他应用的共享 public schema 上盲目执行：初始迁移为专用项目设计，会收紧 public 表权限。已有用户会回填 profile 与三种默认简报。生产数据建议开启备份。

2. **配置 Auth**。启用 Email / Magic Link；Site URL 填 Vercel 正式 HTTPS 地址，Redirect URLs 加上 `https://YOUR_APP/auth/callback`。本地开发另加 `http://localhost:3000/auth/callback`。生产应配置自己的 SMTP，Supabase 默认邮件服务有限制。想保持单人使用，可在创建本人账号后关闭公开新用户注册。

3. **部署 Vercel**。项目根目录设为本仓库，框架 Next.js，构建 `npm run build`。填写：

   | 变量                          | 放置位置                                                         |
   | ----------------------------- | ---------------------------------------------------------------- |
   | NEXT_PUBLIC_SUPABASE_URL      | Vercel：Supabase 项目 URL                                        |
   | NEXT_PUBLIC_SUPABASE_ANON_KEY | Vercel：anon / publishable key（公开键，RLS 必须开启）           |
   | SUPABASE_SERVICE_ROLE_KEY     | Vercel 服务端：service-role / secret key，绝不加 NEXT_PUBLIC_    |
   | NEXT_PUBLIC_APP_URL           | Vercel：正式 HTTPS 地址（预留配置；当前回调采用请求站点 origin） |
   | TELEGRAM_BOT_TOKEN            | Supabase Edge Function secrets，仅服务端                         |
   | TELEGRAM_WEBHOOK_SECRET       | Supabase Edge Function secrets                                   |
   | SCHEDULER_SECRET              | Supabase Edge Function secrets 与 Vault，两处必须一致            |

4. **创建 Bot**。Telegram 私聊官方 `@BotFather`，发送 `/newbot`，记录 token 到安全密钥设置。机器人不响应普通未授权消息或群聊，只处理有效绑定码；日历数据只发给已绑定的私聊。一个 Telegram chat 只能绑定一个用户。

5. **设置 Edge 密钥**。在 Supabase Dashboard → Edge Functions → Secrets 填写上述三项；SUPABASE_URL 与 SUPABASE_SERVICE_ROLE_KEY 是托管 Edge 默认提供的系统变量。生成两个不同的随机 secret：

   ```bash
   openssl rand -hex 32
   # 再运行一次，另一个 secret 必须不同
   ```

   本地也可用未提交的 `.env.edge` 文件：

   ```bash
   npx supabase secrets set --env-file .env.edge
   npx supabase functions deploy telegram-webhook --no-verify-jwt
   npx supabase functions deploy notification-worker --no-verify-jwt
   ```

   `--no-verify-jwt` 是为了接收 Telegram 与 Cron 请求；两端仍各自验证 webhook secret / scheduler bearer secret，不能省略。函数共享的 Deno 配置位于 `supabase/functions/deno.json`。

6. **注册 webhook**。运行 `scripts/register-webhook.mjs`，通过受保护的本地环境变量提供 token、webhook secret 与 `TELEGRAM_WEBHOOK_URL`（值为 `https://YOUR_PROJECT.supabase.co/functions/v1/telegram-webhook`）：

   ```bash
   node --env-file=.env.edge scripts/register-webhook.mjs
   ```

   `.env.edge` 必须未提交。脚本仅打印成功 / 状态，不打印 token；绑定码不写日志。机器人只接收 message 更新。Telegram 的 `X-Telegram-Bot-Api-Secret-Token` 会由 Telegram 自动发送。

7. **开启后台 Cron**。Supabase Dashboard 启用 Cron (`pg_cron`)、`pg_net`、Vault。使用 Vault UI 保存 `ying_worker_url` 为 worker 的完整 HTTPS URL，`ying_scheduler_secret` 为同一 SCHEDULER_SECRET。执行 `supabase/cron.sql` 一次。它每分钟通过 pg_net 调用 worker。重复安装前检查已有 job，使用 `cron.alter_job` 修改已有任务，避免创建多份。检查 `cron.job_run_details` 和 `net._http_response` 的 HTTP 状态，Cron 调用成功不等于消息送达。

8. **真实验证**。用邮箱登录应用 → 设置 → 连接 Telegram → 私聊你的机器人发送十分钟有效的一次性代码 → 等待下一分钟 → 刷新连接状态与通知历史。必须在 Telegram 实际收到测试消息，且 `notification_deliveries.state=sent` / 有 delivered_at，才算通路成功。静音时段会延迟测试消息，必要时明确修改偏好后再测。07:00 或自定义发送时间不能只看浏览器计时；在浏览器关闭时也应收到通知。

## 调度与可靠性

- Cron 永远按 UTC 每分钟执行，数据库将 tick 转为每用户 IANA 时区。默认 London 的 07:00 / 22:00 / 周日 19:00 随 BST 自动转换。送达与计划时间存储 timestamptz（UTC），界面按偏好时区显示。
- 简报唯一键含 schedule id 与本地日期，秋季重复时段不重复发送。每次补查最近五分钟；长于五分钟的 Cron 停机可能错过简报，需检查运维日志。自定义到春季被跳过的 01:xx 不会凭空生成该时刻，建议使用 02:00 之后的时间。
- 持久队列以事务 `FOR UPDATE SKIP LOCKED` 领取，限 5 条 / 批，租约两分钟。发送速率低于每秒一条。明确的 Telegram 429 / 5xx 拒绝进行指数退避，遵守 retry_after，最多五次。
- Telegram API 没有发送幂等键，网络超时或发送成功但记录失败不能保证 exactly-once。这些记录标记 uncertain，不自动重发；先检查实际私聊。租约过期也标记 uncertain。数据库去重防止重复 enqueue，不掩盖这个外部 API 限制。
- 静音时段始终优先，重要提醒不绕过。断开 Telegram 后停止新入队，并在发送前复核绑定与活动状态。提醒改期使用新 due_at 键，旧队列发送前检查是否仍批准 / 到期。已完成准备任务不会发送。
- 提醒默认 proposed；截止通常按学术任务或高优先级建议 7 / 3 / 1 天，其他任务提前一天。演示额外提前三天，工作坊提示核实材料和注册，Stage Crew 提示核实安全鞋与会员，地点 / 交通触发出发检查。不是推测这些要求已经被主办方确认。
- 默认提醒强度 normal；low 过滤低优先级提醒。high 暂与 normal 相同，不额外制造通知。长简报截断至 Telegram 单条限制，并提示在应用查看余项。

## 验证通知全链路

用你自己的真实活动（明确来源）创建并确认一条临近的 booked 活动。到设置页批准一条准备提醒并将其时间改到两分钟后。关闭浏览器，确认 Telegram 收到；重复触发 worker 时同一幂等键不应重复送达。设置静音后重复测试应延迟。断开连接后不应继续接收新消息。

检查：

```sql
select kind, state, attempts, scheduled_at, delivered_at, error
from public.notification_deliveries
where user_id = auth.uid()
order by created_at desc;
```

SQL Editor 管理员执行时没有用户会话，需使用你本人 user_id 过滤。不要把数据库导出或密钥放进聊天 / Git。

## 导入与后续工作

接口及模板见 [docs/INGESTION.md](docs/INGESTION.md)。你的 DFPI Excel 尚未上传，上传后须逐条核实：Monday C4D Group A / Tuesday Coding Group A 应结束于 13:00；research dossier deadline 要进入截止字段；photography first choice 保持 applied。未知年份、缺失时间、复杂宽格式课表和重复规则不会被擅自补全。

未实现项：完整结构化 LLM 解析、Google OAuth 同步、邮件 / push、重复实例展开、附件上传与实时交通路线。托管部署、真实邮件登录、Telegram webhook/Cron 与真实端到端发送需要你提供服务配置后验证；本地测试不等于上线。
