# 受控导入 API v1

Supabase 是唯一事件存储。导入不会直接写入 events：先保存 change_proposals，用户确认后通过事务 RPC `confirm_proposal` 修改事件、追加来源与历史。拒绝不改变事件。

`POST /api/ingest` 使用 Supabase 会话 Cookie，要求同源 Origin；没有公开的无认证写入入口。服务端 service-role 仅用于创建当前用户的导入批次和提议。每用户每分钟最多 10 个导入批次。最大请求 4 MB、最大文件 4 MB、每文件最多 500 条；Vercel 本身还有请求大小限制。Excel 解压声明大小超过 20 MB 会被拒绝。

JSON 消息：

```json
{ "text": "这场 Model Photography Workshop 先标记为待考虑" }
```

结构化事件（新增；修改附上已有 event_id）：

```json
{
  "event": {
    "title": "你的活动名称",
    "category": "academic",
    "status": "considering",
    "timezone": "Europe/London",
    "start_at": null,
    "end_at": null,
    "deadline_at": null
  },
  "source_url": "https://www.ucl.ac.uk/",
  "source_notes": "用户提供的信息，日期尚待核实"
}
```

返回 `{count, message}`；随后从本人 `change_proposals` 读取提议。确认调用 Supabase RPC：

```ts
await supabase.rpc("confirm_proposal", { proposal_id: id, accept: true });
```

修改提议携带 expected_version，确认时检查事件版本。过期版本会被拒绝，需重新编辑生成提议。API 不接受客户端指定所有者。未来助手连接应使用独立、带权限范围的认证适配器，不应共享 service-role 或把当前 Cookie API 暴露为匿名端点。

文件使用 multipart/form-data，字段名 `file`。支持 CSV / .xlsx / .ics / ChatGPT JSON 导出。CSV 与 Excel 第一行是表头，每个工作表一个活动表，模板见 `import-template.csv`。支持 title / 名称、start_at / 开始时间、end_at / 结束时间、deadline_at / 截止时间、location / 地点、source_url / 来源等字段。

日期应是包含年份与时刻的 ISO，例如 `2026-11-24T10:00:00+00:00`。不含偏移但有明确时刻的 CSV/Excel 字符串按用户时区处理。夏令时跳过或重复的本地时间必须提供 UTC 偏移，否则进入核实。Excel 的纯日期格式不会转成午夜活动。截止与活动是独立字段，纯日期截止仅保留原始记录，不创造时刻。

导入不会默认确认出席，状态缺失默认待考虑；显式状态 booked / confirmed 才保留为预约 / 确认，且仍须用户批准提议。ICS 本身不提供个人预约证明，因此默认待考虑。Google Calendar 可以导出 ICS 后导入；实时 OAuth 同步尚未实现。ICS 重复规则保存为来源与 recurrence_rule，但暂不展开；全天、浮动或无法可靠转换的时间保留为未知。

同标题且同实际开始/截止时间可匹配已有记录。更新会追加来源而不删除旧来源。文件内互相重复的行仍须审核，不能批量无检查确认。自然语言使用规则，支持状态与唯一匹配课程的结束时刻；未唯一匹配不会直接修改已有记录。历史 ChatGPT JSON 仅提取用户文字并保留原时间戳，不把历史“明天”当成今天的明天，也不会自动匹配当前预约。长篇文本不是完整语义解析，复杂日期与表格须人工整理。无需也不假设直接访问 ChatGPT 私人历史。
