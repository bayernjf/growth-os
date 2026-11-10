# AGENTS.md

本仓是 Tier0 组合级落码 **growth-os（G1 只读调研闭环）** 的产物，AI 协作者必须遵守。

## 本地容器运行时（macOS）

本机 macOS 开发只用 OrbStack，不再使用 Docker Desktop。`docker` / `docker compose`
命令不变（`docker context` 为 `orbstack`）。拉公共镜像直连失败时，用
`docker.m.daocloud.io` 等镜像站前缀兜底。完整约定与恢复步骤见
`../bayjf/AGENTS.md` 的「本地容器运行时约定（macOS）」和
`~/000mycodes-backups/README.md`。

## 状态入口

- `handoff.md` 是本仓状态、待办、基线的唯一主入口，开工前先读它。
- 每完成一个工作单元，立即更新 `handoff.md`（已完成划掉、待办保留），并同步项目仓 `../bayjf/docs/tier0/growth-os-任务列表.md`。

## 定位（G1）

- growth-os 是运营型 Personal Agent 的 L3 业务仓，与 commerce-os 同级同构。
- **G1 只读**：SearchProvider 只做外部/公开数据检索（offline 回放或 online 搜索），全程不登录、不写第三方、不发信、不做交易。
- 搜索源默认 offline 确定性回放；`GROWTH_SEARCH_MODE=online` 缺凭据必须 fail-closed（422），**禁止静默回退离线**。
- 打分为确定性纯函数（0–100，分项可解释）；洞察默认 `pending_review`，人确认后才入库。
- 外发（邮件）在 G3 才引入，且经 zeus 分级（默认 D2 人审）；G1 不依赖 zeus-client。

## 工程纪律

- Node ≥ 22，ESM（`type: module`），import 路径必须带 `.js` 后缀。
- TypeScript 严格全开：`strict` / `noUncheckedIndexedAccess` / `exactOptionalPropertyTypes` / `noUnusedLocals` / `noUnusedParameters`。可选字段在 exactOptional 下只能用条件展开（`...(x ? { k: x } : {})`），禁止显式赋 `undefined`。
- 业务代码只用 `?` 占位符 SQL；方言差异只能出现在 `src/storage/`。新增迁移必须同时写 `db/migrations/sqlite/` 与 `db/migrations/postgres/`，编号文件名一一对应，跑 `npm run check:migrations`。
- 应用生成 TEXT id；时间统一 ISO-8601 TEXT；JSON 在 sqlite 用 TEXT、postgres 用 JSONB，序列化/解析只在 repository 边界。
- 所有密钥（搜索/邮件）只经 env 或 credentialRef，禁止入 git、入文档、入业务库。
- 离线报告必须带"离线演示数据"水印，禁止把 fixtures 冒充真实市场结论。

## 验证门（交付前全绿）

```bash
npm run check:migrations && npm run typecheck && npm run lint && npm test && npm run build
```

## 提交

- 英文原子提交：`<type>(<scope>): <subject>`，按任务分组；**不 push**。
- 提交作者必须是用户本人，禁止 AI co-author trailer。
- 未授权不得 commit。
