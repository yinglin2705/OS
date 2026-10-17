# 私人事件看板

日历 → 点击活动 →「打开事件看板」。每个活动独立保存文字便签、HTTP(S) 来源链接、图片和卡片连线。支持拖动、方向键移动、编辑文字及删除卡片/连线。手机可滚动看板。

图片仅支持 JPEG / PNG / WebP / GIF，最大 8 MB，保存在非公开 Supabase Storage bucket；访问地址按当前用户签名，有效期一小时。链接不自动抓取，文字不作为 HTML 执行。图片链接到期后刷新页面即可更新。原始事件的状态、来源、通知和静音设置不受看板编辑影响。

`002_event_boards.sql` 是增量迁移，不重新运行 001、不包含私人日程。两张表启用账号级 RLS，复合外键阻止把他人的事件/卡片挂到自己的看板。Storage 限制账号目录和事件归属。删除事件会删除卡片及连线；存储中的图片尚无自动孤儿清理任务，可能需要管理员定期清理。删除单张图片卡片会尝试清理对应文件。

部署：推送相关源文件后 `Deploy private event boards` 工作流使用现有 repository secret `SUPABASE_ACCESS_TOKEN`，仅执行 002 并核对 RLS/私有 bucket。Vercel 独立构建前端。没有真实上传/刷新测试前不能宣称端到端已验证。

## 一键确认

AI 收件箱有待处理提议时显示「全部确认（N 条）」。确认窗口概述新增、修改和有警告的数量，处理时显示进度，遇到失败停止并刷新。沿用已有事务 RPC，保留来源与历史，不把 planned / considering 改成 booked，不补造缺失时间。它确认的是写入提议，不是证明来源已核实。

## Google Calendar 自动同步：尚未实现

现已支持 Google 导出 ICS 后导入；OAuth 自动连接、增量同步和后台 Google 同步尚未实现。

推荐下一阶段先实现单向只读同步：Google Calendar API `calendar.events.readonly` 权限、用户显式 OAuth 同意、服务端加密保存 refresh token、Supabase 分钟任务按需增量拉取。需要 Google Cloud OAuth client ID / secret、实际站点 callback URL、测试用户/发布配置。密钥只能通过安全环境设置填写，不能放进聊天或仓库。

Google event ID / calendar ID / originalStartTime 作为外部唯一键，保留来源、updated/etag/syncToken；重复事件按有限日期窗口展开；全天和未知时刻不补午夜；Google RSVP 与个人 booked 分开。远端改动先进入提议，不能覆盖 YING OS 用户更正；删除先标记来源删除，不自动取消已确认安排。AI 可在同步之后帮助总结和提议，不需要用 AI 代替 Google API 授权读取。
