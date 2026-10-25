# growth-os handoff

> 状态主入口。开工前先读；每完成一个工作单元立即更新（已完成划掉、待办保留）。

## Current state（2026-10-25，G1 只读调研 + G2 客户挖掘与 CRM 已落码；GATE-G1 已过、GATE-G2 待用户过门）

- **基线**：6 个测试文件 / **38 用例全绿**；`typecheck` 0 错；`lint` 0 错；`tsc -p tsconfig.build.json` 构建出 `dist/`；sqlite + postgres 迁移各 2 份（`001_research`、`002_crm`，配对）。
- **G1 已落码并实测通过**：
  - 只读搜索连接器 `research/provider/`：`OfflineSearchProvider`（确定性回放 `recordings/search/fixtures.json`，默认）、`OnlineSearchProvider`（Tavily 风格 REST，GET 只读）、`registry`（online 缺凭据 → 拒绝型 provider，run 返回 422，**不静默回退离线**）。
  - 信号引擎：`collector.ts`（规范化 + 指纹去重，指纹 = sha256(规范化 URL) 截 16）、`scoring.ts`（0–100 确定性打分，类型/来源/新鲜度/关键词四项加权，分项可解释，新鲜度半衰期 30 天、无日期取中性 0.5）。
  - 洞察：`insights.ts`（need/pain/comparison 且 score≥60 才聚类，按"类别+首个命中关键词"分组，全部 `pending_review`）；人审 `confirm/reject`，非 pending 重复裁决 → 409。
  - 报告：`report.ts`（stats/Top/洞察/markdown，重 run 版本 v1→v2→v3 不覆盖，离线带"离线演示数据"水印）。
  - 持久化：`research/repository.ts`（StorageDriver 双方言，JSON 仅在边界序列化；signals `(topic_id,fingerprint)` 唯一、reports `(topic_id,version)` 唯一）。
  - 编排 + HTTP：`research-service.ts`、`api/research-http.ts`（Hono，7 个路由 + `/healthz`，可选 Bearer token，GrowthError 统一错误体）。
  - 迁移：`scripts/migrate.mjs`（env `GROWTH_*`）、`scripts/check-migrations.sh`（配对校验，实测 OK）。
- **G1 真实启动实测（本机 node 24，冒烟脚本重跑）**：
  - 离线：建 topic → run，`topic.status=done`，得 15 条信号（16 条 fixtures 去重 1）/ 7 条 pending_review 洞察 / 报告 v1、avg 61、top1=77(intent)、水印 true；二次 run 信号仍 15（去重稳定）、报告 v2；confirm 洞察后再 review 返 409，已确认洞察重跑后保持 confirmed。
  - online 无凭据：建 topic 正常，run 返 `422 CREDENTIAL_MISSING`（不静默离线）。
  - 迁移 CLI：`migrate:up` 应用 001_research，二次运行幂等；5 张表（含 schema_migrations）建出。
- **G2 已落码并实测通过（客户挖掘与 CRM，零外部依赖）**：
  - 数据模型：`002_crm` 迁移 4 表 `contacts`/`leads`/`lead_followups`/`lead_events`（双方言配对；`leads.source_signal_id` 唯一去重，一信号一线索）。
  - 领域：`crm/`（`types.ts`/`repository.ts`/`lead-service.ts`/`watch.ts`）；错误码新增 `INVALID_TRANSITION`（409）。
  - 线索管道：`promoteSignalsToLeads(topicId)` 只提升 `intent` 且 score≥`LEAD_MIN_SCORE`(默认 60) 的信号 → lead，继承评分与分项依据，幂等。
  - 状态机：`new→qualified→contacted→won|lost`、`qualified→lost`；非法流转 fail-closed 409；`lead_events` 记录每次流转审计。
  - 跟进时间线：`lead_followups`（action/note/来源证据/due_at/done_at）；回访 watch：`WatchPort` + `LocalWatch` 本地桩（`due_at<=now 且未完成` 即到期提醒），真实 zeus DelegationContract 待接。
  - HTTP：`api/crm-http.ts`（`/api/v1/crm/*`，contacts/leads/promote/transition/followups/watch）；`serve.ts` 用 Hono `route()` 挂载 research+crm。
- **G2 真实启动实测（node 24 冒烟）**：离线 run 得 15 信号 → promote 得 1 线索（score 77、带来源证据、status new）→ `new→qualified` 合法、`qualified→won` 返 409 `INVALID_TRANSITION` → followup 到期被 `watch/due` 列出、完成后消失 → `lead_events` 记录 1 条流转。
- **无外发**：G1/G2 均不依赖 zeus-client、无任何发信/登录/写第三方代码；外发在 G3 引入并经 zeus 分级。

## 范围

### G1（T-G1-01 ~ T-G1-10，全部完成）

- T-G1-01 脚手架（Node22 ESM、TS 严格、Hono、Vitest、CI 无 clone zeus）
- T-G1-02 四张表 + 双方言迁移 + migrate CLI + check-migrations
- T-G1-03 config（env + 打分默认）与 errors（5 个错误码/状态）
- T-G1-04 SearchProvider 端口 + 离线 provider + fixtures（16 条含重复行）
- T-G1-05 在线 provider + registry（fail-closed，单测覆盖 422/503）
- T-G1-06 采集器（指纹去重）+ 打分纯函数
- T-G1-07 洞察聚类 + 人审状态机
- T-G1-08 报告生成（版本/水印/聚合）
- T-G1-09 编排 + HTTP API + serve 装配
- T-G1-10 端到端契约 + GATE-G1（离线全链路 / online 422 反证 / 五门）

### G2（T-G2-01 ~ T-G2-05 完成；T-G2-06 可选待拍板）

- T-G2-01 lead/contact 模型 + `002_crm` 双方言迁移（4 表）
- T-G2-02 线索来源管道（intent 信号→lead，评分画像继承）
- T-G2-03 线索状态机（new→qualified→contacted→won/lost，非法流转 409）
- T-G2-04 跟进时间线（followups + 下一步动作 + 来源证据）
- T-G2-05 回访 watch（WatchPort + LocalWatch 本地桩）
- T-G2-06 外部 CRM 单向同步（可选，待用户拍板，不阻塞主线）

## 测试覆盖（tests/，6 文件 / 38 用例）

- `scoring.test.ts`（5）：高分上限、低词命中、无日期中性、衰减、区间与分项一致性。
- `provider.test.ts`（7）：离线确定性与过滤、online 缺 key 422、结果映射分类、不可达/非 2xx → 503。
- `research-contract.test.ts`（7）：入参校验、采集去重打分聚类报告、幂等重跑、人审 409、reject/404、报告证据水合、online 422。
- `research-http.test.ts`（5）：healthz、建主题+run+取报告、400、Bearer 401、online 422。
- `crm.test.ts`（10）：联系人增读/校验、状态机合法+非法+终态、promote 幂等+阈值、followup 完成、watch 到期。
- `crm-http.test.ts`（4）：lead 增读+非法流转 409、404、跨 HTTP promote 端到端+幂等、Bearer 401。

## 待办

- [x] GATE-G1：已过门（24 用例 + 冒烟 4 条验收全绿）。
- [ ] GATE-G2：用户过门（代码与冒烟已备）。
- [ ] 待用户拍板：真实搜索源（Tavily/火山 Ark）与 key；T-G2-06 是否接外部 CRM（HubSpot/表格）；G3 邮件通道（Gmail/飞书/SMTP）与签核档。
- [ ] G3 邮件触达（T-G3-01 ~ 06，引入 zeus-client，默认 D2，估 3–4 天）。
- [ ] G4 运营化（外部依赖：真实云/域名/密钥/合规）。

## 环境/运行

- `npm run check:migrations && npm run typecheck && npm run lint && npm test && npm run build`
- `npm run migrate:up`（sqlite，默认 `./data/growth-os.db`）；`npm start`（默认 127.0.0.1:8788，offline）。
- 配置见 `.env.example`；所有密钥仅 env，禁止入 git/文档/业务库。

## 备注

- 与 `commerce-os` 同构：存储层（driver/sqlite/postgres/migrate）、tsconfig/eslint/vitest、check-migrations、CI 结构一致；G1/G2 均不含 zeus-client。
- 实现相对设计文档的一处精简：signals 未存 `raw` 原始响应列（G1 fixtures 已结构化），接真实源时如需原始快照再加迁移列；设计文档已对齐。
- G2 watch 为本地桩（`WatchPort`），真实回访提醒随 zeus DelegationContract/daemon tick 接入（T-G2-05 的 zeus 侧）；外部 CRM 同步（T-G2-06）写回经 D1/D2，待拍板。
