# growth-os handoff

> 状态主入口。开工前先读；每完成一个工作单元立即更新（已完成划掉、待办保留）。

## Current state（2026-11-04，2026-11-02 评审修复批已落码并过门、已落 dev（未上 main）；此前 M1 销售闭环 OP-10~14/18 已合 main）

- **2026-11-02 评审修复批（2026-11-04 落码并过门；已落 dev（未上 main）——`5b32375`/`693e655`/`1513338`/`2ad4d60`/`cf78933`/`19cba25` 经 `git branch -r --contains` 仅命中 `origin/dev`；评审原文见 `docs/reviews/code-review-2026-11-02.md`）**：
  - `/mcp` 未配置 token 改为 fail-closed 401（`src/api/mcp-http.ts`，提交 `5b32375`）。
  - 订单号改由数据库序列在插入事务内分配，消除 `countOrders()+1` 并发撞号；新增 `013_orders_contract_unique` 与 `014_order_number_sequence` 双方言迁移（提交 `693e655`）。
  - `tsconfig.build.json` 排除 `src/**/*.test.ts`，测试文件不再进 `dist/`（提交 `1513338`）。
  - 抑制名单邮箱匹配大小写归一（`trim().toLowerCase()` + `LOWER(email)`，提交 `2ad4d60`）。
  - 迁移 DDL 与 `schema_migrations` 记录合并为单事务（`src/storage/migrate.ts`，提交 `cf78933`）。
  - `README.md` 与本文件更正搜索连接器为 Tavily 风格 `POST /search`（提交 `19cba25`）；同批更早两笔为 malformed JSON 请求体返回 400（提交 `b75441c`，契约测试 `0426fb4`）。
  - 验证：Node 22.23.4 实跑 `npm test` **31 文件 / 212 用例全绿**（2026-11-04）。

- **M1 销售-交付闭环本地核心（OP-10~14/18 已合 main：`fcbfbbe`/`2232ff7`，`git branch -r --contains` 命中 `origin/main` 与 `origin/dev`）**：
  - 迁移（双方言，check-migrations 12 对）：`010_sales_quotes`（quotes 行项 JSON/整数分金额/状态 draft→sent→accepted|rejected + quote_events 审计）、`011_sales_contracts_orders`（contracts draft→sent→signed；orders quote→order，delivery_status 预留 OP-15、invoice_ref 预留 OP-16）、`012_order_fulfillment_invoices`（履约状态与发票行，随 PR #9 落地）。
  - `src/sales/`：types（行项/状态机）、repository（双方言 mapRow、状态转换+审计事件同事务、order_no）、sales-service（金额校验：qty 正整数/单价非负/单一币种/总额由行项求和；跨实体门槛——未 accepted 不能建 contract、未 signed 不能建 order；OP-18 createQuoteFromLead）。
  - **zeus 分级（OP-13）**：`SalesDecisionGate`，报价 ≥ `GROWTH_QUOTE_APPROVAL_THRESHOLD_CENTS`（默认 500000=5000.00）走 zeus；低金额零外发 D0 自动；高金额 zeus 不可用即抛 503 fail-closed（RejectingDecisionPort），D2 时 quote 留 draft 挂 decisionId（202 pendingApproval），resolve-approval 见终态再发。
  - HTTP：`/api/v1/sales/{quotes,contracts,orders}` + send/accept/reject/resolve-approval/sign 动作（src/api/sales-http.ts，Bearer 复用 crm-http），serve.ts 装配。
  - 验证：sales-service 10 例（金额非法、状态机、跨实体门槛、D2 挂起/解决、fail-closed 零外发、lead 转换）+ sales-http 3 例（401/400/409/全链）；全量 **26 文件/178 用例**（+13）五门全绿；守卫回退实测变红。**OP-15/16 已改为本地闭环、OP-17 GATE-W2 全链 e2e 已随 `2232ff7`（PR #9）合 main（`012_order_fulfillment_invoices` 与 `tests/sales-e2e.test.ts` 均在 `origin/main`）；跨 agent-dev/agent-world 的语义匹配版本未采用**。

- **T-G3-07 多语言外联（2026-11-01）已过门**（PR #7 合并 main）：
  - **多语言模板**：src/mail/templates.ts（renderEmailTemplate en/zh，默认 en 按设计 §14.3.3）输出 subject/text/html 三态；html 部分对收件人/线索内容 escapeHtml 防注入；无 compliance 时省略页脚。
  - **回复理解翻译**：src/mail/reply-translator.ts（detectLocale / classifyReplyIntent：unsubscribe 优先、auto/question/interest/other / OfflineReplyTranslator 离线不编造翻译、保留原文，接口兼容在线实现）；recordReply note 追加 intent/locale 标注（PII 不落日志，§14.1.2）。
  - **退订合规闭环（§14.2.1）**：src/mail/unsubscribe-token.ts（HMAC-SHA256 绑定邮箱的退订 token，常量时间校验、地址绑定）；公开端点 POST /pub/v1/outreach/unsubscribe（无 Bearer；缺 secret fail-closed 422；token 无效 400）；complianceFactory 注入 DraftWriter，每封外发邮件页脚含身份标识加退订链接；assertMailCompliance boot 门——smtp 模式缺 GROWTH_MAIL_IDENTITY / GROWTH_MAIL_UNSUBSCRIBE_BASE_URL / GROWTH_MAIL_UNSUBSCRIBE_SECRET 任一即拒启。
  - **接线补齐**：campaign locale（http 校验 en/zh，非法 400）→ writer → 009_outreach_locale 双方言迁移（outreach_drafts 追加 body_html 列，locale 列一并落库）→ 草稿落库/发送均携带 html；sendDraft 有 html 时随邮件发送。
  - **验证门五项全绿（24 文件 / 165 用例）**；真实启动冒烟：healthz 200、无 secret 退订 422、无 Bearer 401、posture 日志含 unsubscribe=、smtp 缺合规配置拒启（真实进程验证）。
- **Tier0 评审追补批次（2026-10-31）已落码并过门**（同报告遗留项收尾）：
  - **H4 lead 状态 + 转换事件同事务（PR #2）**：`CrmRepository.transitionLeadStatus` 经 `StorageDriver.transaction` 把 lead 状态 UPDATE 与 `lead_events` 审计追加收进同一事务（sqlite/postgres 双驱动各自实现，审计写失败即回滚），消除"状态已变但无审计"的崩溃窗口。
  - **P2 500 回显泛化（本批）**：新增共享 `src/api/on-error.ts` `growthOnError` —— `GrowthError` 原样透传（既有错误码语义不变），其余异常一律 `{code:'INTERNAL', message:'internal error'}` 500，原文与栈只进服务端日志；research/crm/outreach/match 四个 HTTP 应用统一接入，不再回显驱动/表名等内部细节。
  - 验证门五项全绿（19 文件 / 110 用例）。
- **Tier0 评审修复批次（2026-10-30）已落码并过门**（评审报告：bayjf `docs/tier0/Tier0-代码评审报告-2026-10-30.md`）：
  - **H1 fail-closed 启动门**：`GROWTH_API_TOKEN` 缺失/为空即拒绝启动（exit 1 + 明确错误，`src/util/boot.ts` 纯函数可单测）；启动日志新增一行授权姿态 `auth posture: mode=researchBearer=callbackSecret=search=zeus=mail=`。
  - **P1 常量时间 token 比较**：`secureEqual`（双侧先 sha256 定长再 `timingSafeEqual`）替换 research/crm/outreach/match 的 Bearer 比较与 MCP token 比较，消除时序泄漏与长度泄漏。
  - **P1 回调签名 + 幂等**：`GROWTH_OUTREACH_CALLBACK_SECRET`（config + `.env.example`）；`POST /api/v1/outreach/receipts/{bounce,reply}` 必须带 `X-Growth-Signature: v1=<hex HMAC-SHA256(secret, 原始请求体字节)>`（先读 raw body 再 parse；secret 未配置 fail-closed 401；验签常量时间）；载荷必须带 `eventId`，经 `outreach_callback_events` 表（`007_callback_events` 双方言迁移）insert-first-wins 幂等，同 id 重放返回首次结果且不重复改抑制名单/CRM。
  - **H3 typecheck 修红**：`tests/mcp-http.test.ts` fixture 用显式结构类型（提交 897ded5，无 any/@ts-ignore）。
  - 验证门五项全绿（18 文件 / 104 用例）；无 token 拒启与姿态日志已真实启动冒烟复核。
  - 本批未做两项已在 2026-10-31 追补批次收尾：500 回显驱动错误文本、lead 状态+审计同事务（H4），见上方追补批次。
  - **边界**：T-G2-05 预定落码形状（zeus watch connector / `watch_reminders` 表）按拍板**未提前实现**。
- **GATE-G2 已过门**（2026-10-25，owner 复核）：五门全绿（38 用例/6 文件、typecheck/lint/build/迁移配对 0 错，node 22 复核）；真实服务冒烟 **16/16**（15 信号→1 线索[分数与源信号一致、带证据]→状态机合法流转+非法 409→promote 幂等→followup 到期进 watch/due、完成后消失→lead_events 审计 1 条）。
- **G3 已签核（2026-10-25 owner），已落码并过门**：邮件通道 **SMTP 优先**（厂商中立、全球可用；Gmail/飞书后续适配器）。详细设计见 bayjf `docs/tier0/growth-os-设计方案.md` v1.2 §13。T-G3-01（zeus-client DecisionPort）、T-G3-02（MailPort + SMTP 适配器）、T-G3-03/04（campaign 草稿 + zeus 签核发送流）、T-G3-05（回执跟踪/suppress）、T-G3-06（GATE-G3）已落码；**GATE-G3 已过门**。
- **G5 撮合引擎（2026-10-25）已落码并过门**：`match/`（买方需求/卖方货源/匹配对 + 信号结构化 + 五维打分 + 编排 + 撮合介绍/联系）+ `005_match` + `006_contact_email` 迁移；真实服务冒烟 **10/10**（healthz→建需求/货源→run 匹配 1 对 score 90→reasons 可解释→介绍渲染→联系路由→accept）。
- **跨境合规**：设计方案 v1.1 新增 §14 全球化与跨境合规硬约束（数据最小化、PII 出域控制、CAN-SPAM/CASL/GDPR ePrivacy、suppress list、打开跟踪默认关闭）；G3 落码时强制执行。
- **定级**：growth-os 已登记 bayjf `docs/PROJECT-TIER-CONVENTION.md` Tier 0。
- **注意**：本机默认 shell node 20 跑不了测试（`node:sqlite` 需 22.5+），用 `fnm use 22` 后再跑五门。

- **基线**：31 个测试文件 / **212 用例全绿**（2026-11-04 Node 22.23.4 实跑）；`typecheck` 0 错；`lint` 0 错；`tsc -p tsconfig.build.json` 构建出 `dist/`；sqlite + postgres 迁移各 14 份（`001_research`、`002_crm`、`003_outreach`、`004_outreach`、`005_match`、`006_contact_email`、`007_callback_events`、`008_lead_import`、`009_outreach_locale`、`010_sales_quotes`、`011_sales_contracts_orders`、`012_order_fulfillment_invoices`、`013_orders_contract_unique`、`014_order_number_sequence`，配对）。
- **G1 已落码并实测通过**：
  - 只读搜索连接器 `research/provider/`：`OfflineSearchProvider`（确定性回放 `recordings/search/fixtures.json`，默认）、`OnlineSearchProvider`（Tavily 风格 REST，POST /search 只读）、`registry`（online 缺凭据 → 拒绝型 provider，run 返回 422，**不静默回退离线**）。
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
- T-G2-05 回访 watch（WatchPort + LocalWatch 本地桩；真实化 2026-10-27 复核挂账，见「待办」）
- T-G2-06 外部 CRM 单向同步（已拍板：跳过，用自带 CRM；G4 再评估）

### G3（T-G3-01~07 全部完成；GATE-G3 已过门，T-G3-07 为追加批次）

- T-G3-01 接入 zeus-client + DecisionPort：`decision/`（`types.ts` DecisionPort 端口 / `zeus.ts` ZeusDecisionAdapter / `registry.ts`）；`GROWTH_ZEUS_MODE=off` 默认无决策后端、offline 端口 fail-closed 503，online 缺凭据 422；zeus-client 不可达/非 2xx 映射 `DECISION_UNAVAILABLE` 503（retryable）。
- T-G3-02 邮件通道适配器：`mail/`（`types.ts` MailPort + OutboundEmail / `smtp.ts` SmtpMailAdapter（nodemailer，STARTTLS 587 / 隐式 TLS 465）/ `registry.ts`）；`GROWTH_MAIL_MODE=off` 默认无外发、offline 端口 fail-closed 503，smtp 缺 host/from 422；send 失败映射 `MAIL_UNAVAILABLE` 503。
- T-G3-03 campaign/草稿：`outreach/content.ts` DraftWriter 端口 + TemplateDraftWriter（本地确定性个性化；loom ContentClient 为后续可选适配器）。
- T-G3-04 签核发送流：`outreach/outreach-service.ts`（submit→zeus 分级→approval→mail 发送）+ `003_outreach` 迁移 3 表（campaigns/outreach_drafts/outreach_events）+ `api/outreach-http.ts`（8 路由）；**无 zeus 签核零外发**（send 仅当 approved，decisionId/messageId 全程审计）。
- T-G3-05 回执跟踪：`004_outreach` 迁移 `suppressed_emails`；退信→suppress（再发送被拦）、回复→lead followup 回流、打开跟踪默认关闭（无 pixel，§14.2）。
- T-G3-06 端到端 + GATE-G3：真实服务冒烟 7/7（healthz→contact/lead/campaign→draft→submit 503 DECISION_UNAVAILABLE→send 409 CONFLICT→审计仅 created）；**无 zeus 签核零外发**强反证通过；approve→send 全链路 + 审计回放由 `outreach.test.ts` 覆盖。
- T-G3-07 多语言外联（跨境增量 J4，追加批次）：`src/mail/{templates,reply-translator,unsubscribe-token}.ts` + `009_outreach_locale` 双方言迁移（locale+body_html）+ campaign locale 校验 + `POST /pub/v1/outreach/unsubscribe` + boot 合规门；详见 Current state。

### G5（T-G5-01~05 全部完成；GATE-G5 已过门）

- T-G5-01 撮合数据模型：`match/types.ts`（BuyerDemand/SupplierOffer/Match）+ `005_match` 双方言迁移 3 表（buyer_demands/supplier_offers/matches）+ `match/repository.ts`。
- T-G5-02 信号结构化：`match/structurer.ts`（classifySignal demand/offer/unknown + extractCategory/Quantity/Prices/Region，规则优先、缺字段不硬填）。
- T-G5-03 匹配引擎：`match/matcher.ts`（五维打分：品类40/数量20/价格20/交期10/地区10，纯函数可解释）。
- T-G5-04 编排 + API：`match/match-service.ts`（create/runMatch/accept/reject/ingestSignal，score≥60 幂等）+ `api/match-http.ts`（8 路由）+ serve 装配。
- T-G5-05 撮合闭环 + GATE-G5：`match-e2e.test.ts` 需求信号+货源信号→撮合；真实服务冒烟 8/8。
- 撮合联系（FR-22）：`MatchService.buildIntroduction` 生成撮合介绍 + `contactMatch` 路由到 outreach（撮合实体 email → 自动建 contact/lead/campaign/draft，缺 email 回退 ownerEmail）；`006_contact_email` 迁移加 email 列 + structurer extractEmail；`OutreachService.createContactDraft` 直接指定收件人建草稿。

## 测试覆盖（tests/，31 文件 / 212 用例）

- `outreach-http.test.ts`（11）：回调 secret 未配置 fail-closed 401、缺签/错签/错钥 401 且零副作用、签名退信 suppress + eventId 重放幂等、缺 eventId 400、签名回复回流单条 followup + 重放返回首次结果、未知 messageId 404；T-G3-07：campaign locale 合法 201/非法 400、退订端点缺 secret 422、有效 token 幂等 suppress、无效 token 400 零副作用、/pub/v1 无 Bearer 公开。
- `boot.test.ts`（10）：GROWTH_API_TOKEN 缺失/空串拒启、配置正常、姿态行 set/unset 与模式映射；T-G3-07 assertMailCompliance：off 放行、smtp 缺 identity/baseUrl/secret 各拒启、全配放行。
- `error-response.test.ts`（3）：GrowthError 原样透传、非 GrowthError 500 泛化体不回显原文、原文只进服务端日志（GET 路径断言）。
- `secure-compare.test.ts`（4）：相等/同长不等/异长不抛/空串语义。
- `matcher.test.ts`（7）：五维打分各维度边界、品类 mismatch/general、价格数量越界、同地区 vs 跨境、缺字段中性。
- `structurer.test.ts`（8）：demand/offer/unknown 分类、品类/数量/价格/地区提取、缺字段不填。
- `match.test.ts`（3）：需求/货源/匹配 CRUD。
- `match-service.test.ts`（5）：校验、幂等匹配、阈值、accept/reject、信号 ingest。
- `match-e2e.test.ts`（4）：需求信号+货源信号→撮合闭环、介绍渲染、联系路由。
- `outreach.test.ts`（12）：campaign/草稿创建、无邮箱 lead 跳过、submit→approve→send 审计链、reject、zeus off 零外发强反证、退信 suppress 拦发送、回复回流 followup、未知 messageId 404；T-G3-07：zh locale 草稿（含退订页脚/html）落库往返、默认 en、sendDraft 携带 html、回复 note 含 intent/locale。
- `templates.test.ts`（6，T-G3-07）：en/zh 渲染、compliance 页脚含 identity+退订链接、无 compliance 省略页脚、html 转义防 XSS、isEmailLocale 枚举。
- `reply-translator.test.ts`（10，T-G3-07）：detectLocale zh/en/unknown、classifyReplyIntent 五类优先级、OfflineReplyTranslator 保留原文不编造。
- `unsubscribe-token.test.ts`（5，T-G3-07）：token 往返、篡改 MAC/跨 secret/畸形 token 拒、地址绑定。
- `mail.test.ts`（5）：off 模式 fail-closed 503、smtp 缺 host/from 422、live 适配器、jsonTransport 发送返回 messageId、send 失败 → MAIL_UNAVAILABLE 503。
- `decision.test.ts`（6）：off 模式 fail-closed 503、online 缺凭据 422、live 适配器、decide 返回分级、网络失败/非 2xx → DECISION_UNAVAILABLE 503。
- `scoring.test.ts`（5）：高分上限、低词命中、无日期中性、衰减、区间与分项一致性。
- `provider.test.ts`（7）：离线确定性与过滤、online 缺 key 422、结果映射分类、不可达/非 2xx → 503。
- `research-contract.test.ts`（7）：入参校验、采集去重打分聚类报告、幂等重跑、人审 409、reject/404、报告证据水合、online 422。
- `research-http.test.ts`（6）：healthz、建主题+run+取报告、400、Bearer 401、online 422、非 GrowthError 500 泛化且原文进日志。
- `crm.test.ts`（10）：联系人增读/校验、状态机合法+非法+终态、promote 幂等+阈值、followup 完成、watch 到期。
- `crm-http.test.ts`（4）：lead 增读+非法流转 409、404、跨 HTTP promote 端到端+幂等、Bearer 401。

## 待办

- [x] GATE-G1：已过门（24 用例 + 冒烟 4 条验收全绿）。
- [x] GATE-G2：已过门（2026-10-25 owner 复核，冒烟 16/16）。
- [x] G3 签核：已签核（2026-10-25 owner，SMTP 优先 + 签核发送流 + 回执跟踪），落码 T-G3-01~06 进行中。
- [x] 真实搜索源：已拍板 **Tavily**（2026-10-25）；key 由 owner 填 env（`GROWTH_SEARCH_MODE=online` + `GROWTH_SEARCH_BASE_URL` + `GROWTH_SEARCH_API_KEY`），不入库。现有 online provider 即 Tavily 风格，无需改码。
- [x] Tavily 真实搜索已接通（2026-10-26）：key 已填本地 `.env`；`serve.ts` 启动时用 `process.loadEnvFile` 加载 `.env`（放在 serve 而非 config，避免污染单测）；真实搜索冒烟 10 信号全绿（provider=online、带真实 URL）。
- [x] T-G2-06 外部 CRM：跳过（2026-10-25，用 growth-os 自带 CRM，暂不接 HubSpot/表格；G4 运营化再评估）。
- [x] GATE-G3：已过门（2026-10-25，57 用例 + 真实服务冒烟 7/7 零外发强反证）。
- [x] G3 邮件触达（T-G3-01~06 全部完成，默认 D2；强制执行设计方案 §14.2 邮件合规）。
- [x] T-G3-07 跨境增量 J4 多语言外联（2026-11-01 拍板，同日落码并过门；PR #7 合并 main，24 文件 / 165 用例 + 真实启动冒烟）。
- [x] GATE-G5：已过门（2026-10-25，81 用例 + 真实服务冒烟 7/7 撮合闭环）。
- [x] G5 撮合引擎（T-G5-01~05 全部完成：数据模型/结构化/匹配/API/闭环）。
- [ ] G4 运营化（外部依赖：真实云/域名/密钥/合规；含 SPF/DKIM/DMARC 与跨境数据评估）。
- [x] Tier0 评审 P2 挂账（2026-10-30 报告）——已收尾（2026-10-31 追补批次）：非 GrowthError 的 500 回显改为泛化 `INTERNAL` 体、原文只进日志（`src/api/on-error.ts` 统一接入四个 HTTP 应用）；lead 状态写与 `lead_events` 审计收进同一事务（H4，PR #2，`CrmRepository.transitionLeadStatus` + `StorageDriver.transaction`）。
- [ ] T-G2-05 回访 watch 真实化 —— **2026-10-27 复核挂账**（growth-os 仓零代码改动；基线 14 文件/84 用例全绿复核通过，HEAD d9490f7）。
  - 只读核对 zeus（未改 zeus 仓）：watch 触发面已 boot 装配——`POST/GET/DELETE /api/watches`、`POST /api/watch-tick`（bearer、caller 驱动节拍，内核不持定时器；zeus `src/http/server.ts` ~L2644-2770、`src/state/boot.ts` 装配 WatchRegistry + runWatchTick）；watch 读数源仅三：`metrics`（zeus 内核自指标）、`realm`（仅 entryCount / lastItemModifiedAt 两个元数据）、`connector`（须握手注册的声明工具，出站走 zeus 守卫）。`packages/zeus-client` 只导出 Decision API v1，无 watch/realm/intent 面。
  - 结论：growth-os 的 CRM followup 对 zeus tick 完全不可见，单仓离线无法闭合「由 zeus tick 驱动到期提醒」：(a) growth-os 不是 zeus connector（缺声明/握手接入，跨仓）；(b) realm 读数无逐条 due 语义，即便能 push 条目也表达不了「followup F 到期」；(c) 唯一能写提醒的 `POST /api/intents` 是 skill dispatch 门（tier-1 对未注册 skill 拒 403 skill_unavailable），不是人审提醒登记口，growth-os 在 zeus 无注册 skill。
  - 落码前置（bayjf tier0 设计稿拍板二选一）：
    ✅ **已拍板（2026-10-29，owner）：选项 2——growth-os 以 connector 接入**
    （watch-native 长路径：growth-os 暴露 `crm.listDueFollowups` 只读工具 →
    zeus connector 声明/握手 → 注册 `source=connector` watch + budget +
    plan intent；需跨仓 onboarding 设计）。选项 1「zeus 新增 bearer reminders
    登记面」已否决。
  - 闭合后 growth-os 侧预定落码形状（勿提前写）：ZeusWatchAdapter 包 LocalWatch（本地到期判定为唯一事实源）+ `GROWTH_ZEUS_MODE=off` 默认 fail-closed + 007 幂等表 `watch_reminders(followup_id unique, external_id, raised_at, resolved_at)`（sqlite+postgres 双方言，防重复 tick 重复上报）+ 注入 fetch 的裸 bearer client（离线 fake zeus 测试）。
  - DelegationContract 非阻塞：plan 模式人审提醒本就不需要契约；execute 无人值守提醒的 `delegationId` 登记面 zeus 已就绪（`POST /api/watches` 接受 delegationId，execute fire 派生一次性子票）。

## 环境/运行

- `npm run check:migrations && npm run typecheck && npm run lint && npm test && npm run build`
- `npm run migrate:up`（sqlite，默认 `./data/growth-os.db`）；`npm start`（默认 127.0.0.1:8788，offline）。
- 配置：复制 `.env.example` 为 `.env`（gitignored），`serve.ts` 启动时自动加载 `.env`；所有密钥仅 env，禁止入 git/文档/业务库。

## 备注

- 与 `commerce-os` 同构：存储层（driver/sqlite/postgres/migrate）、tsconfig/eslint/vitest、check-migrations、CI 结构一致；G1/G2 均不含 zeus-client。
- 实现相对设计文档的一处精简：signals 未存 `raw` 原始响应列（G1 fixtures 已结构化），接真实源时如需原始快照再加迁移列；设计文档已对齐。
- G2 watch 为本地桩（`WatchPort`）；2026-10-27 复核挂账：zeus watch 触发面虽已就绪，但读数源读不到 growth-os followup（metrics/realm 元数据/connector 握手均不通），真实化前置缺口与落码形状见「待办」T-G2-05；外部 CRM 同步（T-G2-06）写回经 D1/D2，待拍板。

## 对外运营 M1 销售闭环 · OP-15/16/17（2026-11-01，分支 feature/sales-m1-fulfillment）

- 背景：OP-10~14、18 已在 main（PR #8）。核实后 OP-15/16 改为 growth-os 本地闭环
  （agent-dev 无订单交付端点、agent-world invoice 是其自身 SaaS 订阅计费，均不适用）。
- 迁移 **012_order_fulfillment_invoices**（sqlite+postgres 配对，check-migrations 12 对）：
  `order_events`（delivery/invoice 审计）+ `invoices`（order_id 唯一，open/paid/void，external_ref 预留外部账单）。
- OP-15 履约：delivery_status 状态机 pending→delivered→verified（verified 终态，不回退），
  service `markDelivered/markVerified` + repository 事务（状态与事件同写）；HTTP
  `POST /api/v1/sales/orders/:id/deliver|verify`、GET …/events。
- OP-16 发票：`issueInvoice(orderId)` 金额/币种服务端取自订单（客户端无法传金额），
  一单一票幂等，同事务写 orders.invoice_ref 并记 invoice 事件；不接 Stripe/网关。
  HTTP `POST|GET /api/v1/sales/orders/:id/invoice`。
- OP-17 GATE-W2：tests/sales-e2e.test.ts 全链（lead→quote D2 审批→contract→order→
  delivered→verified→invoice）+ 失败路径（未交付不能 verified、终态不回退、一票幂等、
  未签合同不能下单）；sales-http 补 2 个契约用例。零真实网络（fake DecisionPort）。
- 验证：Node 22 五门全绿；测试 178→**185**（+7）。守卫变红实证：markVerified 放宽到
  pending 即 e2e 失败；invoice 金额改 0 即金额一致性用例失败；均已恢复。
- 未做（跨系统真实对接）：invoice external_ref 未来接外部账单；delivery 暂为本地登记。
