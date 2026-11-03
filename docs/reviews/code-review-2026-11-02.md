# growth-os 深度代码评审报告（2026-11-02）

> 只读评审，未修改任何源码、未提交。评审基线：HEAD `2232ff7`（main，Merge PR #9）。
> 每条结论附证据（文件:行号 / 命令输出 / 实测结果）；未实测项明确标注「未实测」。

## 1. 仓库定位与规模概览

- 定位：Tier0 组合内 L3 业务系统「运营型 Personal Agent」——市场调研（G1 只读信号引擎）、CRM（G2）、邮件外联（G3，zeus 签核门禁）、撮合（G5）、对外运营 M1 销售-交付闭环（OP-10~18）。与 commerce-os 同级，由 zeus 内核编排。
- 技术栈：Node ≥22（`node:sqlite` 实验特性）、TypeScript 严格全开、Hono HTTP、Vitest；存储双方言 sqlite（本地/测试）+ postgres（生产可选，`pg` 为可选依赖）。
- 规模：源码 `src/` 53 个 TS 文件 / 6614 行；`tests/` 27 个测试文件；源码+测试合计 9972 行。迁移 12 对（sqlite + postgres 配对，`check-migrations` 实测通过）。
- 入口：`src/serve.ts`（装配 8 个 Hono 子应用 + fail-closed 启动门 + 合规门 + posture 日志）。

## 2. 结论摘要

- **P0：0 条**（默认绑定 127.0.0.1 + 主 API fail-closed Bearer 门，未发现可远程直接利用的漏洞）。
- **P1：2 条**　**P2：6 条**　**P3：7 条**
- 最关键 3 条：
  1. **签收回调在生产不可用**：`/api/v1/outreach/receipts/{bounce,reply}` 落在 `/api/v1/*` Bearer 中间件之后，生产环境（`GROWTH_API_TOKEN` 强制配置）下正确签名的回调不带主 token 实测返回 401，ESP webhook 无法回流退信/回复（详见 P1-1）。
  2. **失败的 research run 把 topic 永久卡在 `running`**：`setTopicStatus('running')` 后 provider 抛错无任何 catch/finally，实测确认失败后状态不回落（P2-1）。
  3. **Postgres 驱动在单连接上直接 BEGIN/COMMIT**，并发请求的事务边界会交错（P1-2，postgres 为生产路径）。

## 3. 验证门实际执行结果（本机 Node v22.23.4，fnm）

| 门 | 结果 | 关键输出 |
|---|---|---|
| `npm run check:migrations` | ✅ 通过 | `OK: paired migrations (12 files each, sqlite + postgres)` |
| `npm run typecheck` | ✅ 通过 | tsc 0 错 |
| `npm run lint` | ✅ 通过 | eslint 0 错 |
| `npm test` | ✅ 通过 | **27 文件 / 185 用例全绿**（5.12s） |
| `npm run build` | ✅ 通过 | 产出 `dist/` |

补充实测（真实进程冒烟）：fail-closed 拒启由 `tests/boot.test.ts` 覆盖；本人另行实测了无 token 访问 `/api/v1/research/topics` → 401、签名回调 → 401（见 P1-1）、`/mcp` 无 token → 开放（见 P2-2）、畸形 JSON → 500（见 P2-6）。

## 4. 逐条发现

### P1 — 严重缺陷

#### P1-1 签收回调端点被 Bearer 中间件拦截，生产环境回调链路不可用

- **位置**：`src/api/outreach-http.ts:44-52`（`/api/v1/*` 中间件）覆盖 `:120` 的 `/api/v1/outreach/receipts/bounce` 与 `:144` 的 `receipts/reply`；`src/serve.ts:86, 140`（apiToken 启动门强制非空后传入）。
- **证据**：
  - 设计（`.env.example` 与 handoff 2026-10-30 批次）规定回调凭据是 `X-Growth-Signature` HMAC，不含主 token；
  - 实测（真实启动 dist/serve.js，`GROWTH_API_TOKEN=test-token`）：带正确 HMAC 签名、不带 Bearer 的 bounce 请求返回 **401**；带 Bearer 后才进入签名校验逻辑。
  - 测试盲区：`tests/outreach-http.test.ts:21-42` 构造 app 时不传 `apiToken`，中间件惰性放行，从未覆盖生产组合。
- **影响**：真实部署下邮件服务商 webhook（通常无法自定义 Authorization 头）打不进回调，退信不会进 suppress list、回复不回流 CRM——G3 合规闭环在生产实际断开；且签名密钥沦为冗余（主 token 已足够）。
- **修复建议**：把 receipts 两条路由挂到 `/pub/v1/*`（与 unsubscribe 一致，仅靠 HMAC 签名 + eventId 幂等），或在中间件里对这两条路径放行；补一个「apiToken 已配置 + 仅签名」的 HTTP 测试。

#### P1-2 Postgres 驱动事务在共享单连接上 BEGIN/COMMIT，并发下事务边界交错

- **位置**：`src/storage/postgres/postgres-driver.ts:67-95`（`transaction` 直接用唯一的 `this.client` 发 `BEGIN`/`COMMIT`/`ROLLBACK`）；`src/serve.ts:90` 全应用共享一个 driver。
- **证据**：`pg` 单 client 的查询串行排队，两个并发 HTTP 请求同时进入 `transaction()` 时会出现 `BEGIN; BEGIN; … COMMIT; COMMIT;` 交错（第二个 BEGIN 在 pg 中报 "there is already a transaction in progress" 级别问题，ROLLBACK 会误滚另一个请求的在途事务）。**未实测**（本地未装可选依赖 `pg`），结论基于单连接语义与代码结构。
- **影响**：postgres 生产部署下并发的 lead 状态流转 / quote 状态机 / 发票签发会互相污染，审计事件可能与状态写错位或整体回滚。
- **修复建议**：改用 `pg.Pool`，每次 `transaction()` `pool.connect()` 取独立连接，在 finally 中 release。

### P2 — 质量/正确性/合规

#### P2-1 失败的 run 把 topic 永久留在 `running`

- **位置**：`src/research/research-service.ts:82-84`（先 `setTopicStatus('running')`，随后 `provider.search` 抛错直接出栈，无 catch/finally；`:129` 才置 `done`）。
- **证据**：实测（dist + 注入抛错 provider）：`topic.status after failed run = running`。现有 422 契约测试（`tests/research-contract.test.ts:151-173`）只断言错误码，未断言 topic 状态。
- **影响**：online 缺凭据/搜索不可达后，topic 永远显示 running，UI/运营无法区分「进行中」与「已失败」。
- **修复建议**：run 内 try/catch，失败置 `failed`（需迁移扩枚举或复用现有状态）并记录错误摘要。

#### P2-2 `/mcp` 端点 fail-open，未配置 token 时暴露含 PII 的到期跟进

- **位置**：`src/api/mcp-http.ts:25-33`（`if (deps.mcpToken)` 才校验）；`src/util/boot.ts:64-74` posture 不含 mcp 字段。
- **证据**：实测未配置 `GROWTH_MCP_TOKEN` 时 `POST /mcp tools/list` 无凭证返回工具清单；`tools/call` 返回的 followups 含 lead 标题与 note（note 内含回复原文，`src/outreach/outreach-service.ts:221-223`）。`.env.example:20-22` 已文档化「unset = open」，属有意设计但与本仓其余 fail-closed 姿态不一致。
- **影响**：一旦绑定地址超出 localhost（`GROWTH_HOST` 可配），CRM 跟进数据裸奔；posture 日志也不提示 mcp 开放状态。
- **修复建议**：boot 门增加 mcp 告警/拒启选项；posture 行加 `mcp=set|unset`。

#### P2-3 回调幂等为 check-then-act，并发重放可产生重复 followup

- **位置**：`src/outreach/outreach-service.ts:245-256`（`recordReplyCallback` 先 `getCallbackEvent` 再 `recordReply` 再 `recordCallbackEvent`，且忽略后者 insert-first-wins 的布尔返回值，`src/outreach/repository.ts:317-325`）。
- **影响**：同一 eventId 并发投递时两个请求都通过「未见过」检查，各建一条 lead followup（真实重复副作用）；且冲突时返回的是自己新建的 followup 而非首次结果，与「重放返回首次结果」语义不符。未实测（并发时序），基于代码路径。
- **修复建议**：改为 insert-first-wins 驱动——先尝试插入占位事件，冲突即查回首次结果返回；副作用与事件记录收进同一事务。

#### P2-4 订单号生成与「一合同一订单」均无并发保护

- **位置**：`src/sales/sales-service.ts:217-220`（`listOrders().length + 1` 生成 `ORD-%05d`，再 `findOrderByNo` 查重）；`db/migrations/sqlite/011_sales_contracts_orders.sql:23-36`（`orders` 仅 `order_no` UNIQUE，`contract_id`/`quote_id` 无 UNIQUE，service 也不查同 contract 既有订单）。
- **影响**：并发建单同号 → 靠 UNIQUE 兜底抛 500（非 409）；同一已签合同可被重复下单，金额重复计入。
- **修复建议**：`orders.contract_id` 加 UNIQUE（双方言新迁移），`createOrder` 先查既有订单返回 409；订单号改由单事务内 `COUNT(*) + 1` 或唯一序列生成。

#### P2-5 回复被分类为 unsubscribe 意图但不触发 suppress（合规缺口）

- **位置**：`src/mail/reply-translator.ts:32-50`（能识别 unsubscribe 意图）vs `src/outreach/outreach-service.ts:215-224`（`recordReply` 只追加 followup，不调用 `addSuppressed`）。
- **影响**：用户回信「退订/unsubscribe」后地址不进 suppress list，后续 approved 草稿仍会发出——与设计方案 §14.2（CAN-SPAM/CASL/GDPR ePrivacy 精神）存在张力。**未确认**是否为有意留给人工处理。
- **修复建议**：确认拍板；若应自动 suppress，在 `recordReply` 中 `intent === 'unsubscribe'` 时追加 `addSuppressed(from, 'unsubscribe-reply')` 并记审计。

#### P2-6 多数路由的畸形 JSON 请求体返回 500 而非 400

- **位置**：如 `src/api/research-http.ts:32`、`src/api/sales-http.ts:32` 直接 `await c.req.json()` 无 catch；仅 `lead-import-http.ts:31-36`、`mcp-http.ts:35` 做了捕获。
- **证据**：实测 `POST /api/v1/sales/quotes` 带 `{bad json` → 500 ProblemDetails。
- **修复建议**：在共享层（如 growthOnError 识别 `SyntaxError` → 400 VALIDATION_FAILED，或统一封装安全 json 读取）处理。

### P3 — 规范/体验/文档一致性

1. **测试文件误入 src 且不执行**：`src/modelhub/reservation.test.ts` 不在 vitest include（`vitest.config.ts:24` 仅 `tests/**`，实测 `npx vitest run src/modelhub/reservation.test.ts` 报 No test files found），却被 `tsc -p tsconfig.build.json` 编译进 `dist/modelhub/reservation.test.js`（实测存在）。建议移入 `tests/` 并在 build tsconfig 排除 `*.test.ts`。
2. **handoff「基线」过期**：`handoff.md:39` 仍写「24 个测试文件 / 165 用例」「迁移各 9 份」，实测 27 文件 / 185 用例 / 12 对迁移；`handoff.md:105-127` 测试覆盖清单同样停在 165。
3. **README/handoff 称在线搜索为「Tavily 风格 GET」**：`README.md:22`、`handoff.md:41`；实际实现为 `POST {baseUrl}/search`（`src/research/provider/online.ts:71-78`）。功能无碍，文档失真。
4. **handoff 描述的 500 泛化体与实现不符**：`handoff.md:22` 称 `{code:'INTERNAL', message:'internal error'}`，实际实现为 RFC 9457 ProblemDetails（`src/api/on-error.ts:21-30`，测试与实现一致）。文档应更新。
5. **posture 日志缺 mcp 字段**：`src/util/boot.ts:64-74`、`src/serve.ts:148-153`，见 P2-2。
6. **`toDollarParams` 会替换字符串字面量中的 `?`**：`src/storage/postgres/postgres-driver.ts:40-44` 全局替换；当前业务 SQL 无字面量 `?`，属脆弱约定，建议注释约束或实现简易词法跳过引号内内容。
7. **suppress 邮箱未做大小写/空白规范化**：`src/outreach/repository.ts:272-292` 精确匹配存储与查询，`Foo@x.com` 与 `foo@x.com` 视为不同地址，抑制可被大小写绕过。建议入库与查询统一 `trim().toLowerCase()`。
8. **迁移应用非事务化 + ALTER 非幂等**：`src/storage/migrate.ts:48-63` 先 `exec(DDL)` 后插 `schema_migrations`，二者间失败会留下「DDL 已应用但未登记」状态；`008/009` 的 `ALTER TABLE ADD COLUMN` 无 IF NOT EXISTS，重跑即报错。另外 `scripts/check-migrations.sh` 只比对 `CREATE TABLE` 表名集合，不比对列/约束，配对校验较浅。

## 5. 数据模型与迁移一致性（专项结论）

- sqlite/postgres 12 对迁移文件名一一对应、表集合一致（check-migrations 实测 OK）；抽查 007/010/011/012 的关键约束（`order_no UNIQUE`、`invoices.order_id UNIQUE`、`outreach_callback_events` 主键）双方言一致。
- 缺口：`orders.contract_id` 无唯一约束（P2-4）；状态枚举仅靠 service 层约束，双方言均无 CHECK 约束（注释形式存在）；`leads.source_ref`（008）无唯一约束，webhook/CSV 重投产生重复 lead（与 P2-6 同类，归并为导入无幂等）。

## 6. 依赖与构建健康

- 依赖克制：`hono`、`@hono/node-server`、`nodemailer` 两个 `file:` 兄弟仓（zeus-client、@model-hub/model-kit，本机均存在）。`pg` 为可选生产依赖、不进本地 CI，设计合理且文档一致。
- 构建健康：五门全绿；唯一瑕疵是测试文件被编译进 dist（P3-1）。
- CI（`.github/workflows/ci.yml`）覆盖 clone 兄弟仓、build、check-migrations 等；与本报告范围（代码与本地验证门）一致，未深审。

## 7. 文档与实现一致性（handoff 核对）

handoff.md 与代码现状总体高度一致（fail-closed 门、secureEqual、回调签名、H4 同事务、M1 销售闭环均核实为真）。偏差共 4 处，均为文档滞后/失真而非代码缺失：165→185 用例基线（P3-2）、GET→POST（P3-3）、500 体描述（P3-4）、以及「insert-first-wins 幂等」的表述强于实现（实现是 check-first，见 P2-3）。

## 8. 修复优先级建议

1. **先做 P1-1**（回调挂 `/pub/v1/*` 或中间件放行 + 补生产组合测试）——直接决定 G3 合规闭环在真实部署是否成立。
2. **P1-2** 在启用 postgres 前必须修（pool + 独立连接事务）；sqlite-only 运营期间可排第二。
3. P2 批次：P2-1（topic 卡 running）、P2-4（订单并发/重复下单）优先；P2-3、P2-5、P2-6、P2-2 随后。
4. P3 随日常迭代顺带清理（测试文件归位、handoff 基线刷新、邮箱规范化、迁移登记事务化）。
