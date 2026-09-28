# 架构设计

## 一、整体架构

GateSQL 是一个**纯 Next.js 全栈单体**，单容器、双 SQLite 文件。没有独立后端进程、没有消息队列、没有外部依赖服务。

```
                         浏览器
                            │
             ┌──────────────┴───────────────┐
             │  提问（fetch + ReadableStream）│  CRUD（Server Actions）
             ▼                              ▼
┌────────────────────────────────────────────────────────────┐
│                  Next.js 16 (App Router) · 单进程            │
│                                                             │
│  app/page.tsx ········· RSC 外壳 + Client 对话组件           │
│  app/runs/[id]/ ······· RSC 服务端折叠历史事件渲染            │
│  app/api/chat/route.ts  Route Handler → ReadableStream(SSE)  │
│  app/actions/ ········· Server Actions（报表 / 纠正样本 CRUD）│
│  proxy.ts ············· JWT 校验 + IP 限流（Next 16 中        │
│                         由 middleware.ts 更名而来）           │
│                            │                                │
│                            ▼                                │
│  ┌──────────────── lib/agent/loop.ts ────────────────┐      │
│  │  六步主循环 · 多维预算 · 指纹环路检测 · 失败六分类   │ ★手写 │
│  └───┬─────────┬──────────┬──────────┬───────────────┘      │
│      │         │          │          │                      │
│      ▼         ▼          ▼          ▼                      │
│  时间归一   上下文装配   LLM 调用   SQL 执行链               │
│  date-fns   schema切片   openai     ┌──────────────────┐    │
│                         SDK        │ guard.ts    ★手写 │    │
│                          │         │ lint.ts（口径）   │    │
│                          │         │ explain.ts（EQP） │    │
│                          │         │ worker 池执行     │    │
│                          │         └──────────────────┘    │
└──────────────────────────┼──────────────────┼──────────────┘
                           │                  │
                           ▼                  ▼
                  ┌────────────────┐   ┌──────────────┐
                  │ 火山方舟/DeepSeek│   │ shop.db      │ 只读
                  │ (cassette 可拦截)│   │ 被分析的业务库 │
                  └────────────────┘   └──────────────┘
                                       ┌──────────────┐
                                       │ app.db       │ 读写
                                       │ trace/报表   │ 物理隔离
                                       └──────────────┘
```

★ 标记的两个文件是全项目的两处核心实现（agent 主循环与安全检查），设计见 [Agent 设计](05-agent-design.md) 与 [安全设计](07-security.md)。

## 二、为什么这样分层

Next.js 全栈最容易犯的错是「什么都塞进 Server Action」或「什么都走 Route Handler」。本项目的分界线是明确的：

| 场景 | 用什么 | 为什么 |
|---|---|---|
| 问答（长时流式） | **Route Handler** 返回 `ReadableStream` | Server Actions 不支持流式增量返回。手写 SSE 才能推送 agent 的多步过程 |
| 报表 / 纠正样本的增删改 | **Server Actions** | 短事务、需要 `revalidatePath`、天然带 CSRF 防护。这条边界本身就是面试可讲的判断 |
| 历史 run 详情页 | **RSC** | 服务端用 `reduceEvents` 折叠落库事件直接渲染，分享出去无需 JS 即可阅读 |
| 实时对话区 | **Client Component** | `useReducer` 消费增量事件，用的是**同一个** `reduceEvents` |
| 鉴权与限流 | **proxy.ts**（Next 16 中由 middleware.ts 更名） | 在所有路由之前统一拦截 |

### `reduceEvents` 为什么是纯函数

```
事件数组 ──► reduceEvents(events) ──► RunState
   ▲                                     │
   │                                     ├─► 服务端：RSC 渲染 /runs/[id]
   │                                     └─► 客户端：useReducer 实时折叠
   └── 也可以喂假事件数组直接单测
```

这一步提纯几乎零成本，换来三件事：**从架构上消灭「刷新后看到的和实时看到的不一致」这类 bug**；得到一个能喂假事件数组直接单测的纯逻辑点（流式 UI 极少见的可测点）；第 1 周做「假的但完整的网站」时，它是唯一能先写完的测试。

## 三、一次请求的完整数据流

```
用户敲回车
  │
  ├─ 客户端 fetch POST /api/chat，AbortController 挂上
  │  （不用 EventSource —— 它只能 GET 且不能带自定义头）
  │
  ├─ middleware：校验 JWT cookie → IP 滑动窗口限流 → 放行
  │
  ├─ Route Handler 建 ReadableStream，立刻推 run_started                        [A1]
  │
  ├─ [不调 LLM] 时间归一：AS_OF_DATE=2026-08-31，"近30天" → 2026-08-02~08-31   [A2]
  │                        推 time_resolved 回显
  │
  ├─ [不调 LLM] 上下文装配：确定性 schema 裁剪 + 枚举值注入 + few-shot 打分     [A3]
  │                        全文存入 step 表，推 context_built（只推表名）
  │
  ├─ [不调 LLM] 提前拒答闸门：口径歧义词典 / 时间窗整体越数据水位               [A4]
  │                        命中 → 直达 C2 拒答 + 澄清选项，0 次模型调用
  │
  ├─ [LLM #1] 生成 SQL → Zod 校验 → 推 sql_generated(attempt=N)                 [B1]
  │                        AST 语义指纹查重：两次命中等价写法即终止震荡
  ├─ guard 安全检查（fail-closed）── 拒绝则终止，不重试                          [B2]
  │
  ├─ 口径 lint（fail-open）── block 违规则带缺失谓词回到 B1                      [B3]
  │
  ├─ 列名静态核对（零误报纪律）── 错列则带可用列清单回 B1                        [B4]
  │
  ├─ EQP 代价预检（~1ms）── 缺失 JOIN 条件则拒绝并回到 B1                        [B5]
  │
  ├─ worker 隔离只读执行（主线程 5s 计时，超时放弃等待）→ 推 rows                [B6]
  │
  ├─ [不调 LLM] 结果体检：空结果归因 / 形态可疑 / 数据水位 / 量级校验            [C1]
  │
  ├─ [不调 LLM] 三态判定 + 口径回执卡片（AST 机械生成，模型碰不到）              [C2]
  │
  ├─ [LLM #2] ChartSpec + 结论文字（结论禁止出现数字断言）                       [C3]
  │
  └─ 批量 flush step 到 app.db，推 done（任何分支下都必发）                      [C4]
```

**关键设计**：流程分三段 4-6-4（`A1`~`C4`，编号定义见 [Agent 设计](05-agent-design.md#一主循环三段-4-6-4只有-2-步调-llm)），**14 步里只有 2 步调 LLM**。时间解析、schema 装配、四道校验关卡、结果体检、回执生成全部是确定性代码 —— 这既是准确率的来源，也是评测可复现的前提。

## 四、技术选型

| 层 | 选择 | 理由 |
|---|---|---|
| 框架 | Next.js 16（App Router） | 全栈单框架；RSC + Route Handler 覆盖全部需求 |
| 语言 | TypeScript 严格模式 | 端到端类型安全，SSE 事件协议靠类型系统守住 |
| 样式 | Tailwind + shadcn/ui | 组件源码复制进项目，可控；默认外观即可，UI 设硬时间盒 |
| 图表 | ECharts（`echarts/core` 按需引入 + `dynamic(..., {ssr:false})`） | 中文文档全；按需引入控制包体积 |
| 校验 | Zod | SSE 事件协议、LLM 结构化输出、ChartSpec 三处共用 |
| 数据库驱动 | **`node:sqlite`（Node 24 内置）** | 零编译（避开 Windows + Docker 的 node-gyp 双重雷区）；**有 `setAuthorizer`**，这是安全叙事的核心 |
| SQL 解析 | `node-sql-parser` | AST 白名单、谓词到达性检查、指纹规范化、下钻改写四处共用 |
| 时间处理 | `date-fns` | 相对时间的确定性解析 |
| 模型调用 | 官方 `openai` SDK 指向兼容 baseURL | 火山方舟 / DeepSeek 都兼容 OpenAI 协议 |
| 鉴权 | `jose` 签 JWT + httpOnly cookie | 十几行代码解决真实目标（别让 key 被刷爆） |
| 测试 | Vitest | 只押在「写错了会静默产生错误结论」的地方 |
| 部署 | Docker 单容器（`output:'standalone'`） | 一条命令跑起来直接决定项目是否被看完 |

### 三条被实测证伪的备选方案

这些不是读来的知识，是在这台机器上动手试出来的，构成 ADR 的核心内容：

1. **`prepare()` 对多语句静默截断** —— `prepare('SELECT 1 AS a; DROP TABLE orders').all()` 不报错，静默只执行第一句返回 `[{a:1}]`。驱动给的是虚假的安全感。所以代码路径上绝不能出现 `exec()`，那是唯一的真实多语句入口。
2. **`worker.terminate()` 回收不了卡死的 worker** —— 对卡在同步原生调用里的 worker 永不 resolve（15 秒无反应，连 `process.exit(0)` 都退不出，容器里必须靠 SIGKILL 兜底）。但主线程全程健康。结论：worker 隔离保的只是服务可用性，真正解决超时的是把防线前移到 1ms 的 EQP 预检。
3. **EQP 输出可判定但必须结合行数** —— 三表笛卡尔积返回三行全 `SCAN`，正常三表 JOIN 是 1 SCAN + 2 SEARCH；但 `products` 只有 30 行，对它全表扫描完全合法，「见 SCAN 就拒」会大量误杀。

## 五、目录结构

```
text2sql-agent/
├── README.md
├── docker-compose.yml           第 6 周
├── Dockerfile                   多阶段，output:'standalone'
├── .gitattributes               * text=auto eol=lf（CRLF 进容器会让 entrypoint 报 exec format error）
│
├── docs/                        本文档集
│   ├── 00-product.md ~ 10-engineering.md
│   ├── 09-decisions.md          架构决策记录（23 篇 ADR）
│   ├── eval-log.md              每轮优化的 before/after
│   └── evalset/questions.md     30 题题面（第 1 周冻结并打 tag）
│
├── data/
│   ├── shop.db                  被分析的业务库（只读）
│   └── app.db                   应用自身的库（trace/报表/纠正样本）
│
├── fixtures/
│   ├── llm/*.json               cassette 录制的 LLM 响应
│   └── evalset/gold.jsonl       30 题的 gold SQL + 结果
│
├── scripts/
│   ├── seed_db.py               生成 shop.db（后续可改写为 TS）
│   └── eval.ts                  评测脚本
│
├── src/
│   ├── app/
│   │   ├── page.tsx             主页（RSC 外壳）
│   │   ├── runs/page.tsx        历史列表
│   │   ├── runs/[id]/page.tsx   trace 详情（RSC 用 reduceEvents 渲染）
│   │   ├── login/page.tsx
│   │   ├── actions/             Server Actions（报表、纠正样本）
│   │   └── api/
│   │       ├── chat/route.ts    ★ SSE 主接口
│   │       ├── schema/route.ts
│   │       └── health/route.ts
│   │
│   ├── components/              一个组件一个文件
│   │   ├── chat/                输入框、消息流、状态条
│   │   ├── result/              SQL 展示、表格、图表、回执卡片
│   │   └── schema-sidebar/
│   │
│   ├── lib/
│   │   ├── events.ts            ★ SSE 事件协议（Zod discriminated union，唯一契约）
│   │   ├── reduce-events.ts     ★ 纯函数，前后端共用
│   │   ├── agent/
│   │   │   ├── loop.ts          ★★ agent 主循环
│   │   │   ├── prompts.ts       提示词
│   │   │   ├── llm.ts           模型调用 + cassette 拦截
│   │   │   ├── schema-context.ts 确定性裁剪 + 枚举值注入
│   │   │   ├── time.ts          AS_OF_DATE + 相对时间解析
│   │   │   ├── fewshot.ts       确定性打分检索
│   │   │   ├── budget.ts        多维预算
│   │   │   └── fingerprint.ts   AST 规范化指纹（环路检测）
│   │   ├── sql/
│   │   │   ├── guard.ts         ★★ SQL 安全检查（fail-closed）
│   │   │   ├── lint.ts          口径规则引擎（fail-open）
│   │   │   ├── rules.ts         8 条口径规则的数据结构声明
│   │   │   ├── explain.ts       EQP 代价预检
│   │   │   ├── receipt.ts       口径回执卡片生成（模型碰不到）
│   │   │   ├── executor.ts      worker 池管理
│   │   │   └── worker.ts        worker 线程入口
│   │   ├── db/
│   │   │   ├── shop.ts          只读连接 + setAuthorizer
│   │   │   └── app.ts           应用库连接
│   │   └── verify/
│   │       ├── probe.ts         空结果归因探针
│   │       └── checks.ts        结果体检四项
│   │
│   └── types/
│
└── tests/
    ├── security/                ≥30 条攻击语料
    ├── rules/                   每条口径规则的正反 fixture
    ├── compare/                 结果等价比对器的单测
    └── reduce-events.test.ts
```

★ = 关键契约文件，★★ = 核心实现。

## 六、架构上的三条硬约束

1. **两个 SQLite 文件物理隔离。** agent 持有的只读连接 + `setAuthorizer` 表白名单使它根本看不到 `app.db`。这意味着 agent 不可能通过 SQL 篡改自己的 trace 或读到报表数据 —— 这类问题是任何 SQL 层校验都覆盖不到的。

2. **失败策略刻意不对称。** 安全检查 fail-closed（AST 解析失败即拒绝），口径 lint fail-open（解析失败放过并记 warn）。同一个解析器、两条相反的失败策略，理由是安全上「拒绝」是安全侧、可用性上「放过」是安全侧。这是设计决策而非疏漏，要写进 ADR。

3. **schema 上下文必须是确定性产物。** 同一个问题任何时候生成完全相同的上下文。这是拒绝向量检索的真实理由 —— 一旦裁剪带随机性，同一道评测题两次跑出不同上下文，准确率变化再也无法归因。

## 七、环境变量

见 [工程规范](10-engineering.md#环境变量) 的完整清单。

---

相关文档：[接口约定](03-api-contract.md) · [数据模型](04-data-model.md) · [Agent 设计](05-agent-design.md) · [技术决策记录](09-decisions.md)
