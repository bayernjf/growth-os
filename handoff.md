# growth-os handoff

> 状态主入口。开工前先读；每完成一个工作单元立即更新（已完成划掉、待办保留）。

## Current state（2026-10-25，G1/G2/G3/G5 已落码且过门；G4 运营化待排）

- **GATE-G2 已过门**（2026-10-25，owner 复核）：五门全绿（38 用例/6 文件、typecheck/lint/build/迁移配对 0 错，node 22 复核）；真实服务冒烟 **16/16**（15 信号→1 线索[分数与源信号一致、带证据]→状态机合法流转+非法 409→promote 幂等→followup 到期进 watch/due、完成后消失→lead_events 审计 1 条）。
- **G3 已签核（2026-10-25 owner），已落码并过门**：邮件通道 **SMTP 优先**（厂商中立、全球可用；Gmail/飞书后续适配器）。详细设计见 bayjf `docs/tier0/growth-os-设计方案.md` v1.2 §13。T-G3-01（zeus-client DecisionPort）、T-G3-02（MailPort + SMTP 适配器）、T-G3-03/04（campaign 草稿 + zeus 签核发送流）、T-G3-05（回执跟踪/suppress）、T-G3-06（GATE-G3）已落码；**GATE-G3 已过门**。
- **G5 撮合引擎（2026-10-25）已落码并过门**：`match/`（买方需求/卖方货源/匹配对 + 信号结构化 + 五维打分 + 编排）+ `005_match` 迁移 3 表；真实服务冒烟 **7/7**（healthz→建需求/货源→run 匹配 1 对 score 90→reasons 可解释→accept）。
- **跨境合规**：设计方案 v1.1 新增 §14 全球化与跨境合规硬约束（数据最小化、PII 出域控制、CAN-SPAM/CASL/GDPR ePrivacy、suppress list、打开跟踪默认关闭）；G3 落码时强制执行。
- **定级**：growth-os 已登记 bayjf `docs/PROJECT-TIER-CONVENTION.md` Tier 0。
- **注意**：本机默认 shell node 20 跑不了测试（`node:sqlite` 需 22.5+），用 `fnm use 22` 后再跑五门。

- **基线**：14 个测试文件 / **81 用例全绿**；`typecheck` 0 错；`lint` 0 错；`tsc -p tsconfig.build.json` 构建出 `dist/`；sqlite + postgres 迁移各 5 份（`001_research`、`002_crm`、`003_outreach`、`004_outreach`、`005_match`，配对）。
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

### G2（T-G2-01 ~ T-G2-05 完成；T-G2-06 已拍板：跳过）

- T-G2-01 lead/contact 模型 + `002_crm` 双方言迁移（4 表）
- T-G2-02 线索来源管道（intent 信号→lead，评分画像继承）
- T-G2-03 线索状态机（new→qualified→contacted→won/lost，非法流转 409）
- T-G2-04 跟进时间线（followups + 下一步动作 + 来源证据）
- T-G2-05 回访 watch（WatchPort + LocalWatch 本地桩）
- T-G2-06 外部 CRM 单向同步（已拍板：跳过，用自带 CRM；G4 再评估）

### G3（T-G3-01~06 全部完成；GATE-G3 已过门）

- T-G3-01 接入 zeus-client + DecisionPort：`decision/`（`types.ts` DecisionPort 端口 / `zeus.ts` ZeusDecisionAdapter / `registry.ts`）；`GROWTH_ZEUS_MODE=off` 默认无决策后端、offline 端口 fail-closed 503，online 缺凭据 422；zeus-client 不可达/非 2xx 映射 `DECISION_UNAVAILABLE` 503（retryable）。
- T-G3-02 邮件通道适配器：`mail/`（`types.ts` MailPort + OutboundEmail / `smtp.ts` SmtpMailAdapter（nodemailer，STARTTLS 587 / 隐式 TLS 465）/ `registry.ts`）；`GROWTH_MAIL_MODE=off` 默认无外发、offline 端口 fail-closed 503，smtp 缺 host/from 422；send 失败映射 `MAIL_UNAVAILABLE` 503。
- T-G3-03 campaign/草稿：`outreach/content.ts` DraftWriter 端口 + TemplateDraftWriter（本地确定性个性化；loom ContentClient 为后续可选适配器）。
- T-G3-04 签核发送流：`outreach/outreach-service.ts`（submit→zeus 分级→approval→mail 发送）+ `003_outreach` 迁移 3 表（campaigns/outreach_drafts/outreach_events）+ `api/outreach-http.ts`（8 路由）；**无 zeus 签核零外发**（send 仅当 approved，decisionId/messageId 全程审计）。
- T-G3-05 回执跟踪：`004_outreach` 迁移 `suppressed_emails`；退信→suppress（再发送被拦）、回复→lead followup 回流、打开跟踪默认关闭（无 pixel，§14.2）。
- T-G3-06 端到端 + GATE-G3：真实服务冒烟 7/7（healthz→contact/lead/campaign→draft→submit 503 DECISION_UNAVAILABLE→send 409 CONFLICT→审计仅 created）；**无 zeus 签核零外发**强反证通过；approve→send 全链路 + 审计回放由 `outreach.test.ts` 覆盖。

### G5（T-G5-01~05 全部完成；GATE-G5 已过门）

- T-G5-01 撮合数据模型：`match/types.ts`（BuyerDemand/SupplierOffer/Match）+ `005_match` 双方言迁移 3 表（buyer_demands/supplier_offers/matches）+ `match/repository.ts`。
- T-G5-02 信号结构化：`match/structurer.ts`（classifySignal demand/offer/unknown + extractCategory/Quantity/Prices/Region，规则优先、缺字段不硬填）。
- T-G5-03 匹配引擎：`match/matcher.ts`（五维打分：品类40/数量20/价格20/交期10/地区10，纯函数可解释）。
- T-G5-04 编排 + API：`match/match-service.ts`（create/runMatch/accept/reject/ingestSignal，score≥60 幂等）+ `api/match-http.ts`（8 路由）+ serve 装配。
- T-G5-05 撮合闭环 + GATE-G5：`match-e2e.test.ts` 需求信号+货源信号→撮合；真实服务冒烟 7/7。

## 测试覆盖（tests/，14 文件 / 81 用例）

- `matcher.test.ts`（7）：五维打分各维度边界、品类 mismatch/general、价格数量越界、同地区 vs 跨境、缺字段中性。
- `structurer.test.ts`（8）：demand/offer/unknown 分类、品类/数量/价格/地区提取、缺字段不填。
- `match.test.ts`（3）：需求/货源/匹配 CRUD。
- `match-service.test.ts`（5）：校验、幂等匹配、阈值、accept/reject、信号 ingest。
- `match-e2e.test.ts`（1）：需求信号+货源信号→撮合闭环。
- `outreach.test.ts`（8）：campaign/草稿创建、无邮箱 lead 跳过、submit→approve→send 审计链、reject、zeus off 零外发强反证、退信 suppress 拦发送、回复回流 followup、未知 messageId 404。
- `mail.test.ts`（5）：off 模式 fail-closed 503、smtp 缺 host/from 422、live 适配器、jsonTransport 发送返回 messageId、send 失败 → MAIL_UNAVAILABLE 503。
- `decision.test.ts`（6）：off 模式 fail-closed 503、online 缺凭据 422、live 适配器、decide 返回分级、网络失败/非 2xx → DECISION_UNAVAILABLE 503。
- `scoring.test.ts`（5）：高分上限、低词命中、无日期中性、衰减、区间与分项一致性。
- `provider.test.ts`（7）：离线确定性与过滤、online 缺 key 422、结果映射分类、不可达/非 2xx → 503。
- `research-contract.test.ts`（7）：入参校验、采集去重打分聚类报告、幂等重跑、人审 409、reject/404、报告证据水合、online 422。
- `research-http.test.ts`（5）：healthz、建主题+run+取报告、400、Bearer 401、online 422。
- `crm.test.ts`（10）：联系人增读/校验、状态机合法+非法+终态、promote 幂等+阈值、followup 完成、watch 到期。
- `crm-http.test.ts`（4）：lead 增读+非法流转 409、404、跨 HTTP promote 端到端+幂等、Bearer 401。

## 待办

- [x] GATE-G1：已过门（24 用例 + 冒烟 4 条验收全绿）。
- [x] GATE-G2：已过门（2026-10-25 owner 复核，冒烟 16/16）。
- [x] G3 签核：已签核（2026-10-25 owner，SMTP 优先 + 签核发送流 + 回执跟踪），落码 T-G3-01~06 进行中。
- [x] 真实搜索源：已拍板 **Tavily**（2026-10-25）；key 由 owner 填 env（`GROWTH_SEARCH_MODE=online` + `GROWTH_SEARCH_BASE_URL` + `GROWTH_SEARCH_API_KEY`），不入库。现有 online provider 即 Tavily 风格，无需改码。
- [x] T-G2-06 外部 CRM：跳过（2026-10-25，用 growth-os 自带 CRM，暂不接 HubSpot/表格；G4 运营化再评估）。
- [x] GATE-G3：已过门（2026-10-25，57 用例 + 真实服务冒烟 7/7 零外发强反证）。
- [x] G3 邮件触达（T-G3-01~06 全部完成，默认 D2；强制执行设计方案 §14.2 邮件合规）。
- [x] GATE-G5：已过门（2026-10-25，81 用例 + 真实服务冒烟 7/7 撮合闭环）。
- [x] G5 撮合引擎（T-G5-01~05 全部完成：数据模型/结构化/匹配/API/闭环）。
- [ ] G4 运营化（外部依赖：真实云/域名/密钥/合规；含 SPF/DKIM/DMARC 与跨境数据评估）。

## 环境/运行

- `npm run check:migrations && npm run typecheck && npm run lint && npm test && npm run build`
- `npm run migrate:up`（sqlite，默认 `./data/growth-os.db`）；`npm start`（默认 127.0.0.1:8788，offline）。
- 配置见 `.env.example`；所有密钥仅 env，禁止入 git/文档/业务库。

## 备注

- 与 `commerce-os` 同构：存储层（driver/sqlite/postgres/migrate）、tsconfig/eslint/vitest、check-migrations、CI 结构一致；G1/G2 均不含 zeus-client。
- 实现相对设计文档的一处精简：signals 未存 `raw` 原始响应列（G1 fixtures 已结构化），接真实源时如需原始快照再加迁移列；设计文档已对齐。
- G2 watch 为本地桩（`WatchPort`），真实回访提醒随 zeus DelegationContract/daemon tick 接入（T-G2-05 的 zeus 侧）；外部 CRM 同步（T-G2-06）写回经 D1/D2，待拍板。
