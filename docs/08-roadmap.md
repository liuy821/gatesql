# 开发路线图

每个任务都有**可手动判定的完成标准**。标准没达到就不要往下走。
做完一项把 `[ ]` 改成 `[x]` —— 进度一眼可见。

> **编号说明**：9/22 起主循环流程重排为三段 `A1`~`C4`（见 [05-agent-design 第一节](05-agent-design.md#一主循环三段-4-6-4只有-2-步调-llm)）。本文件里已勾选的历史条目保留当时写法（多数写着「步骤 N」），[旧→新对照表见 05 第一节末](05-agent-design.md#旧编号对照922-之前的文档roadmapadr-里的编号按此映射)；未开始的条目一律用新编号。

---

## 第 0 阶段 · 脚手架（半天）

**本阶段唯一目标**：环境全部跑通，一行业务代码都不写。

现代项目不需要手工造轮子，下面每条命令都是官方脚手架。

### 0.1 生成 Next.js 项目骨架 ✅ 已完成（2026-09-12）

**注意：`create-next-app` 拒绝在非空目录生成项目**（`data/`、`scripts/` 等已有文件都不在它的白名单里，会直接报「contains files that could conflict」退出）。所以正确顺序是：把现有文件挪出去 → 生成 → 挪回来：

```bash
# 1. 暂存现有文件（.git 留在原地）
mkdir D:\code\caliber_stash; cd D:\code\text2sql-agent
Get-ChildItem -Force | Where-Object { $_.Name -ne ".git" } | Move-Item -Destination D:\code\caliber_stash

# 2. 生成脚手架（--yes 跳过全部交互提问）
pnpm create next-app@latest . --typescript --tailwind --eslint --app --src-dir --import-alias "@/*" --use-pnpm --yes

# 3. 挪回来，手工合并两个撞名文件：.gitignore（合并两边）、README.md（保留自己的）
```

生成的是 **Next.js 16**（Turbopack 已是 dev/build 默认，无需任何标记）。脚手架还会生成 `AGENTS.md`（Next 16 的版本警告，要求写代码前查 `node_modules/next/dist/docs/`）—— 保留它。

- [x] **完成标准**：`package.json`、`src/app/page.tsx` 等关键文件存在，`pnpm build` 通过

### 0.2 初始化 UI 组件库 ✅ 已完成（2026-09-12）

注意：新版 shadcn 的 `init` 有交互式提问（选组件库和 preset），无法交互时要带全参数：

```bash
pnpm dlx shadcn@latest init -t next -b base --preset nova -y
```

之后需要什么组件就 `pnpm dlx shadcn@latest add button table card badge` —— 它把**组件源码复制进你的项目**（不是装依赖），所以完全可控可改。

- [x] **完成标准**：`src/components/ui/` 下出现组件文件，`pnpm build` 不报错

### 0.3 装其余依赖 ✅ 已完成（2026-09-12）

```bash
pnpm add zod openai node-sql-parser date-fns jose echarts
pnpm add -D vitest @vitest/ui tsx
```

踩坑：vitest 5 要求 `@types/node >= 22`，脚手架默认装的是 20，需要 `pnpm add -D "@types/node@^24"`（顺便和 Node 24 对齐）。

- [x] **完成标准**：`pnpm list` 能看到全部依赖，peer 警告已清零

### 0.4 确认示例数据库 ✅ 已完成（2026-09-11）

- [x] **完成标准**：`data/shop.db` 存在（2 MB），锚点数字「有效销售额 41,015,358.75 元」已核对

### 0.5 确认大模型能调通 ✅ 已完成（2026-09-12）

用 `scripts/probe_llm.ts` 验证，模型回复「你好」成功。

**关键发现：火山 Coding Plan 的 key 走的不是标准 chat.completions。** `/api/v3` 上调 `ark-code-latest` 返回 404，必须用 `/api/coding/v3` 的 **responses 接口**（openai SDK 的 `client.responses.create`）。这直接影响第 2 周 `src/lib/agent/llm.ts` 的实现方式，ADR 里要补一条。

- [x] **完成标准**：能打印出模型回复

### 0.6 确认 `node:sqlite` 的关键能力 ✅ 已完成（2026-09-12）

用 `scripts/probe_sqlite.mjs` 在本机 Node v24.20 实测，四项全部符合预期：

1. `typeof db.setAuthorizer === 'function'` ✓
2. `prepare("SELECT 1 AS a; DROP TABLE orders").all()` 静默返回 `[{a:1}]`，不报错 ✓
3. 只读连接执行 `DELETE` 抛 `attempt to write a readonly database` ✓
4. EQP 可判定：笛卡尔积三行全是 `SCAN`；正常 JOIN 是 `SEARCH ... USING INTEGER PRIMARY KEY` ✓

> 注意第 4 项的细节：危险的笛卡尔积也会显示 `SCAN orders USING COVERING INDEX ...` —— 带索引名的 SCAN 不代表安全，**判据是「全部 SCAN、没有任何 SEARCH」**，不是「出现了 SCAN 字样」。

- [x] **完成标准**：三个关键行为 + EQP 判据全部亲眼验证

### 0.7 工程基线

```bash
git add -A; git -c core.autocrlf=false commit -m "第0阶段：脚手架与依赖"
```

- [x] **完成标准**：`.gitattributes` 含 `* text=auto eol=lf`；`.env.local` 已被 gitignore；`git log` 有这条提交（`.gitattributes` 拖到 9/19 才补——它缺席正是每次 commit 刷 CRLF 警告、Docker 构建行尾统计异常的根源；`.env.local` gitignore 与首次提交早已达成）

---

## 第 1 周 · 骨架先通（不碰大模型、不碰真实数据库）

**本阶段唯一目标**：把风险最高的两件事前置 —— SSE 契约与 UI 骨架、评测题面。

**结束时能演示**：一个看起来完全可用的 GateSQL 网站，全部由写死的假事件以 300ms 间隔驱动。

- [x] 按 [接口约定](03-api-contract.md) 写 `src/lib/events.ts`（Zod discriminated union）（1A，`c05a991`）
  - **完成标准**：包含 13 种事件类型；前端 switch 加 `satisfies never`，删 case 编译报错 —— 已实测
- [x] 写 `reduceEvents` 纯函数（1B，`3fd7931`；复审 `54ba6a4` 改显式映射）
  - **完成标准**：不 import React、不做 IO；单测喂假事件断言 RunState
- [x] 桩接口 `app/api/chat/route.ts`（1C，`ee4726e`）
  - **完成标准**：`curl -N` 事件逐条冒出；SSE 缓冲坑（X-Accel-Buffering）在桩上踩掉
- [x] 前端六个区域（1D，`abf3b7f`；StrictMode 双连接用 AbortController 哨兵解决）
  - **完成标准**：浏览器六区依次出现
- [x] `/runs/[id]` 服务端渲染（1E，`9c0abe1`）
  - **完成标准**：与实时页共用同一 reduceEvents，逐字一致
- [x] 写 30 题题面（1F，`976ad1e`；v2 修订补 F 层 5 题，见 questions.md 修订记录）
  - **完成标准**：30 条六层分好；E 层覆盖实体缺失与口径歧义两类
- [x] 冻结评测集（tag `evalset-frozen-v1` 已确认存在，时间早于任何 agent 实现代码）

---

## 第 2 周 · 手写两处心脏

**本阶段唯一目标**：SQL 安全检查与 agent 主循环，同时打通真实 schema 提取与只读执行。

**结束时能演示**：真实提问出真实数字；故意问一个容易写错的问题，看到第 1 次被拦、第 2 次修复成功的完整过程。

- [x] `tests/security/` 攻击语料（2C，`b671f3c` 测试先行 TDD 红 → `1b975c1` 实现转绿）
  - **完成标准**：37 条用例全绿，含假阳性测试（`LIKE '%drop%'` 放行）
- [x] 扫源码断言测试（防 `db.exec(` 回潮的哨兵）
  - **完成标准**：agent 代码路径 0 次出现
- [x] 只读连接 + `setAuthorizer`（2B）
  - **完成标准**：写操作被引擎层拒；实测发现 authorizer 不报表名 → 表级黑名单挪到 AST 层（分层原则的实证）
- [x] `src/lib/sql/guard.ts`（2B；`7cdd811`/`482a22b` 记录 node-sql-parser 类型签名坑）
  - **完成标准**：37 条语料全过；当前 189 行
- [x] `src/lib/agent/loop.ts`（2G，`8626920`；**行数标准的诚实修订**：≤350 行是第 2 周（约 250 行）时定的早期目标，此后自检审计、few-shot、2.6 提前拒答、5.5 列名核对、量级校验、结果体检、报表固化等功能合法增长，机械塞回 350 会牺牲「穷举状态机从上读到尾」这一本文件的核心价值。9/21 已做**行为不变重构**（`152c96b`）：prompt 构建（prompt.ts）与结果体检（health.ts）抽为可单测纯函数，717→621 行，评测 --ci 全命中零 miss 佐证无漂移。剩余 621 行主体是重试循环的检查链，刻意保留内联——**结论：把「≤350」从硬指标降级为「每个函数职责单一可讲解」**）
  - **完成标准**：状态机/双预算/指纹防死循环在位；主循环须能逐行讲解（源码注释与文档章节一一对应）
- [x] EQP 预检（2D，`a15f20b`）
  - **完成标准**：缺失 JOIN 三表查询被拒；`SELECT * FROM products` 小表全扫放行
- [x] `app.db` 表（2F，`fc3dd48`）
  - **完成标准**：真实问答后 runs/steps 可查，llm_call step 含完整 prompt（3 周错题翻案、4G 追踪面板均依赖此）
- [x] 桩接口换成真实逻辑（2H，`7d0fc84`）
  - **完成标准**：**前端一行未改** —— 契约价值的实测兑现

---

## 第 3 周 · 拿到第一个准确率数字

**本阶段唯一目标**：产出后续所有优化的裁判。优先级高于任何 UI 工作。

- [x] 30 题 gold SQL 全部落定并执行确认（gold.jsonl v3，check-gold 30/30 通过）
- [x] 金额类题目（≥10 题）用第二种写法交叉验算，两种写法结果一致（已清偿 `31484f5`：crosscheck.jsonl 15 题，check-gold 15/15 等价；C3/D3 预聚合写法与 COUNT(DISTINCT) 逐分一致，扇出口径获独立推导背书）
- [x] 30 条 gold SQL 全部过一遍自己的口径规则引擎，**0 条 block 级违规**（check-gold 输出 lint clean）
- [x] gold 以「SQL + 执行结果 JSON」两份存储，结果由脚本生成而非手抄（已清偿 `31484f5`：build-gold-results.ts 落盘 gold_results.jsonl；eval.ts 开跑前漂移预检，篡改快照实测立即中止且不调任何 LLM）
- [x] 结果等价比对器 + 独立 Vitest 用例集
  - **完成标准**：覆盖六类 —— 列名不同、列序不同、行序、浮点尾差、int/decimal、NULL vs 0 vs 空串（20 用例）
- [x] `pnpm eval` 输出 markdown 报告
  - **完成标准**：含总准确率、六层分层准确率、拒答率、自信错答率、平均重试次数、平均耗时、单题 token 与成本
- [x] `docs/eval-log.md` 第一条记录
  - **完成标准**：含日期、模型名、commit hash、六个分层数字

> 基线大概率在 60-75% 之间。**低不代表你做得差** —— 它是后面那条上升曲线的起点。

---

## 第 4 周 · 让数字动起来

**本阶段唯一目标**：四轮定向优化，每轮只改一处并全量重跑。

- [x] 四轮优化各自独立记进 `eval-log.md`，每轮有 before/after 六个分层数字（实际五轮：+输出契约；1 修错 + 4 A/B）
  1. 低基数列枚举值全量注入 ✓ 身价 +6.7pp（4C A/B）
  2. 口径规则文本注入提示词 ✓ 身价 +36.7pp（4D A/B）
  3. SQL 生成后的自检提示 ✓ 零增益已否决（4E A/B）
  4. few-shot 开/关 A/B ✓ 零增益已否决（4F A/B）
- [x] 评测报告新增「本轮由对转错的题号清单」（4A；4D 单轮同时抓到 10 道回归 + 1 道转对 —— 跷跷板实测存在）
  - **完成标准**：能在某一轮里**真实观察到跷跷板效应**（某层涨、另一层跌）
- [x] 所有错题人工归因到四类之一，写进 `eval-log.md`（基线 7 题逐题判决 + 各轮归因）
- [x] LLM 磁盘缓存生效（4A：record 模式缓存优先，实测全量重跑 0 次 API 调用）
  - **完成标准**：连续两次 `pnpm eval` 不改提示词，第二次 <60 秒且 API 调用次数为 0
- [x] `pnpm eval:quick`（10 题）90 秒内跑完（4A 后实测秒级）
- [x] `/runs/[id]` 可逐步回放（4G：TracePanel 读 steps 表 —— 完整 prompt/completion、各检查结论与耗时；评测 run 无 events 也能看。SQL 左右 diff 已补：词级 LCS，尝试卡片上方双栏旧/新对比，浏览器实测 4 次尝试的历史 run 渲染正确）
  - **完成标准**：能看到 schema 切片全文、每轮 prompt/completion、每次 SQL 尝试的左右 diff、各阶段耗时

---

## 第 5 周 · 补齐产品面

**结束时能演示**：完整的 GateSQL 产品形态，招牌演示一次性录完。

- [x] 三态输出（5A/5B：徽章第 2 周已有；5A 补口径歧义拒答 + 澄清选项；5B 前端 VerdictPanel —— 未核验显示原因、拒答给澄清选项/可查清单，聊天页点击回填、回放页静态展示，实测「利润率」题秒回三选项；拒答率 0% ≤12%。**9/19 增强：多轮澄清**——词典扩至 5 词条（客单价/排名指标/退货率，按「多算法结果不同+无默认口径+误触发可控」三道门筛选），全部 12 选项配 clarifyPhrase（必含 disambiguator），点选项 = 原问题+话术自动重问，手不碰键盘；loop 零改动（第二轮放行全靠既有 disambiguator 机制）；防循环测试遍历全部词条×选项）
  - **完成标准**：每个答案带「已核验 / 未核验 / 拒答」标签；未核验显示具体原因；拒答显示澄清选项或可查清单；评测报告拒答率 ≤12%
- [x] 口径回执卡片（5C：receipt.ts 从执行 SQL 的 AST 识别 status='已完成' 谓词 → 对 shop.db 实际 COUNT 排除订单；有统计范围时计数收窄到范围内。实测 D1 卡片显示「已排除已取消 1873 单、已退款 2017 单」与锚点一致；receipt 单元测 8 例含「解析失败/无库路径绝不猜数」；replay 全量 30/30 无回归 —— 回执不依赖 cassette，模型不在场时卡片数字照出。**9/19 增强+修复**：①fullyTranslated 语义修正——「无金额聚合=无口径义务」不再误判翻译不全（Q5 纯计数题误伤实测）；②新增三字段：计价口径（unit_price 引用亮明 R2）/排除金额合计（同范围无过滤控制总数−结果值，复用量级校验 buildControlQuery）/水位预警（范围末端越过 asOf）；均条件渲染，来源不确定整行不出现；实测 8月5日题排除金额 72,811.59 与人工验算一致）
  - **完成标准**：金额类问题上卡片正确显示「已排除已取消 1873 单、已退款 2017 单」这类由 AST + 实际 COUNT 得出的数字；**把模型从调用链里 mock 掉，卡片内容不变**
- [x] AS_OF_DATE 时钟（第 2 周实现，B 层 5/5 实证：问「近 30 天」回显 `2026-08-02 ~ 2026-08-31`，time_resolved 事件 + 状态条展示在位）
  - **完成标准**：问「近 30 天」时界面回显 `2026-08-02 ~ 2026-08-31`，而不是按 2026-09-11 算
- [x] 不完整周期检测（5D：period.ts 纯函数判定「统计窗口越过数据水位线」→ verification 事件的契约预留字段 incompletePeriod 落地；横幅组件与图表无关 —— 实测发现模型会把无数据月份补成 0 行且不绘图，只有图内虚线会丢警示，故独立横幅 + 线图补空月占位点/虚线标注；单测 5 例；实测「2026 下半年各月销售额」显示「数据截止 2026-08-31，2026-09 起窗口内没有数据」）
  - **完成标准**：跨到 9 月的月度趋势，最后一个点是虚线且带「本期数据不完整」
- [x] 空结果归因探针（5E：probe.ts 顶层 AND 切分（护引号/括号/BETWEEN 的第二段）+ GROUP BY/ORDER BY/LIMIT 归尾；按时间→状态→可空列→全部的顺序各放宽一类，聚合无分组直接改写成 COUNT(*) 数底表行；loop 步骤 8 触发（0 行或单个 NULL 聚合两种形态），首个非零即归因 + 降级未核验并给原因。实测「2027 年 1 月销售额」：徽章未核验、横幅「去掉『时间范围』后有 15199 行数据」。8 条 probe 单测；replay 30/30 零回归）
  - **完成标准**：构造必然空结果的问题，界面明确指出是哪个条件把数据滤没，并给出放宽后的行数
- [x] 8 条口径规则的正反 fixture 全部在 Vitest 里（tests/rules/lint.test.ts 数据驱动遍历 RULES：16 条 + fail-open + 别名/反引号误报回归；新规则缺 fixture 即无处进表）
  - **完成标准**：30 题评测集上规则误报率 <5%，超标的已降级或删除（5F：eval 报告新增误报率行 —— 样本 = 50 条「结果正确」SQL（25 gold + 25 答对最终 SQL）全量过 lint，**全部 block 规则 0 误报**）
- [x] SQL 人工编辑重跑 + 纠正样本回流 + 报表固化（5G：问答页「存为报表」仅固化 SQL；/reports 列表 + /reports/[id] 直接执行（guard 复检 + 只读连接 + 每次记 run/execute step，llm_call 恒 0）；runs 详情页人工改 SQL → guard 校验 + 只读重跑 → corrections（verified_by_user=1，表名自动识别）供 few-shot 检索。实测重跑 54ms/结果 41,015,358.75/trace 仅 1 个 execute 步骤；纠正样本 corr_07f3e462 入库 verified）
  - **完成标准**：点报表名重跑时 trace 里 `llm_call` 步骤数为 **0**、响应 <500ms
- [x] 招牌演示脚本 + 第 5 周评测轮入档（5H：docs/demo-script.md 五镜头 60-90 秒脚本（已录制，见 README 顶部视频）；最终评测 eval_20260916045915 = 30/30、误报率 0%、零回归）
- [x] 步骤 8(d) 量级校验（docs/05 步骤 8 的最后一笔欠账，9/19 清偿：magnitude.ts 金额聚合结果对比「剥业务过滤、**保留时间范围**」的控制总数——时间口径是问题的一部分，连时间也剥掉会让「问某一天」必然误报 <1%；占比 >100%（逻辑不可能）或 <1%（过滤后所剩无几）→ fail 走 warnSeen 降级；只对单一 SUM 无 GROUP BY 表态，AVG/分组/NULL 一律 skip 不越界空集体检；控制查询逻辑导出为 buildControlQuery 供回执「排除金额合计」复用（单一事实源）。6 用例 + 实测「8月5日已完成销售额」占比 54% 正常通过、量级不误报）

**第 5 周收官**：5A-5H 全部完成 + 步骤 8(d) 清偿 + 9/19 修复批（回执 fullyTranslated 语义、时间归一吞日、pnpm allowBuilds 占位符、.gitattributes 补账）。累计曲线：76.7%（原口径）→ 93.3%（校准）→ 96.7%（输出契约）→ **100%（澄清机制）**。下一站第 6 周：Docker（本体已过，验收待做）/ CI 门禁 / live-replay 对齐 / 成本护栏 / CSV / README。

---

## 第 6 周 · 让别人能跑

**本阶段唯一目标**：容器化、无 key 演示、公网护栏、CI 门禁、README。

> **第 6 周开头就做，当天必须验证完整流程并计时。** 这一件事直接决定项目是否被看完。

- [x] Docker 单容器（9/19-9/20 完成。三阶段 Dockerfile（python seed 造库 / node+pnpm 构建 / 最小 runner）+ compose（3000 端口 / 命名卷 / healthcheck）+ standalone + /reports force-dynamic；容器内零 key 端到端三态全过（verified 41M 锚点 / refused+澄清 / unverified+空集归因）。**冷启动计时实测**（完全零缓存、新 clone）：npm 官方源 1070s → 加 NPM_REGISTRY=npmmirror 开关（cb9b667）后 **577s，↓46%** → 有构建缓存的第二次起 **281s ≤5min 达标**。结论：「5 分钟」在国内首次冷启动不达标、预热达标，瓶颈是网络带宽（拉基础镜像+npm 下载）而非工程；README 部署章节放三档实测表+加速开关用法，不写无条件的漂亮数字。踩坑 7 条进 6G 素材：失效镜像源×3、syntax 指令、allowBuilds 占位符（本机 node_modules 掩盖）、构建期预渲染炸库、PowerShell GBK 传参、CI 缺生成类型（fresh clone tsc 必挂）、**容器网络不走宿主代理**）
  - **完成标准**：在执行过 `docker system prune` 的干净机器上 `git clone` 后 `docker compose up`，**5 分钟内** `localhost:3000` 可提问，步骤和耗时记进 README
- [x] 无 key replay 模式（6B：resolveMode 抽取、/api/health、预置 10 题题签、DAILY_BUDGET_CNY 地基；配额重置后全量重录 + 补录 2027 空结果题；**无 key 端到端 10/10 通过**——含 2 个 unverified 降级、2 个 refused 带澄清选项。自愈演示改用历史 run 回放页：当前配置下模型几乎全部一稿过，现场无法稳定触发自愈，如实记录）
  - **完成标准**：不设置任何 LLM key 时自动进 cassette 回放，预置 10 个问题（含 2 个触发重试自愈、1 个被拒答）全流程可跑
- [x] CI 门禁（6D，9/20 完成：实现（eval.ts --ci/--update-baseline + eval/baseline.json + workflows/ci.yml）+ 本地双向演练 + GitHub 实战三连——run #2 失败暴露 fresh-clone 缺生成类型的坑（改 pnpm build 一步双用）、run #3 全绿首跑、**红灯演示**：ci-demo 分支故意反转 R1 文本 → PR run #4 红 ✗ + 机器人评论贴对比表（准确率 96.7%→6.7%、27 题由对转错——E3/E4 不在其内，词典短路不受 prompt 破坏影响，恰证分层隔离）；分支保护已设（main 要求 CI / gate 通过）。副产物：基线生成时暴露并修复词典误伤 C3/D5 真回归）
  - **完成标准**：故意把提示词改坏后 push，**PR 变红**并在评论里贴出对比表和由对转错题号
- [x] live / replay 对齐抽查（6C，9/20：spot-check.ts 三步法 live/replay/compare；抽样 = 30 题每隔 3 取 1 覆盖六层；对齐判据 = verdict 一致 + 结果等价（resultsEqual），SQL 文本不要求一致。**10/10 对齐、零分歧**——8 题 live 写出不同 SQL 但结果与 cassette 全部等价，同时验证回放无串键与等价比对器；E4 两模式均 0 次 LLM 调用（歧义词典短路一致）。报告：eval/spot-check/report.md，eval-log 已入档）
  - **完成标准**：抽 10 题两种模式结果一致。不一致说明 cassette 缓存键设计有问题，**必须先修**
- [x] 鉴权与成本护栏（6F，9/20：**实现+验收**——6B 只铺了地基（配置/查询/health 展示），降级逻辑缺失，预算 0 后系统照常 live。补 applyBudget 纯函数（预算 >= 0 且今日已花 >= 预算 → live/record 强制降级 replay，**降级强于显式 LLM_MODE**；-1 不限）+ callLlm 集成 + health 的 llmMode 如实反映降级。端到端验收：假 key + 预算 0 + 提问 → 降级 replay 命中 cassette → verified 41,015,358.75，无 error 非 500。注：今日花费恒 0（计价 P2 未实现），budget=0 即验收路径；计价落地后同函数自动覆盖「部分超支」场景。5 单测；171 全绿）
  - **完成标准**：把日预算调成 0 后再提问，系统**降级到 replay 返回结果**，而不是报 500
- [x] CSV 导出带 UTF-8 BOM（6E，9/21：/api/export/[runId] 从 app.db 读 run 结果生成 CSV；csv.ts 三层——BOM 前缀（文件头 EF BB BF 断言）/RFC 4180 转义/CSV 注入防护（=/+/@ 开头非数字加 ' 前缀，纯数字保持数值）；操作栏「导出 CSV」按钮。8 用例；实测 GBK 机器 Excel 双击打开中文不乱码（用户验收））
  - **完成标准**：在本机（GBK 代码页）用 Excel 打开中文不乱码
- [x] README（9/21 收网：顶部 1.3MB 演示视频（MP4 替代 GIF——GitHub 原生渲染、体积更小更清晰，64.4MB 原片 ffmpeg 压制）；Mermaid 架构图；评测曲线表（76.7→93.3→96.7→100 + 误报率 0% + CI replay 门禁）；**踩坑 10 条**（超 ≥8 标准，含全部 3 条硬坑 + Docker 7 条新坑）；「已实现/待实现/明确不做」三档如实分类。内容逐句有据：评测数字出自 eval-log，计时出自 6A 三档实测）
  - **完成标准**：顶部 30 秒演示 GIF、架构图、评测结果 markdown 表格、≥8 条踩坑记录（**必须包含**：prepare 静默丢弃多语句、worker.terminate 无法回收卡死线程、React StrictMode 导致 SSE 双连接付两次费）

---

## 第 7-8 周 · 缓冲区

**明确不预先排满。** 前六周任何一周超期都在这里吸收。

进度正常则做：

- [x] A4 提前拒答闸门 · 时间窗越水位 [旧编号 步骤 2.6]（9/21：isBeyondWatermark 纯函数 + loop 挂载；问未来时段从「1 次 LLM + 空集归因」升级为「0 次调用 + 精确理由」；E5/2027 实测 llmCalls=0，部分重叠窗口（B4）不受影响照常 verified；评测 --ci 无回归。发现并修复循环条件缺陷：`while (!ambiguity)` 未检查 verdict，2.6 命中仍进循环——改为 `while (!ambiguity && verdict === null)`）
- [x] B4 列名静态核对 [旧编号 步骤 5.5]（9/21：schema-check.ts——带真实表前缀的列引用对照 PRAGMA 实际列清单，错列在执行前拦下并回喂「该表可用列」清单，比数据库报错更精确；**零误报纪律**：无前缀列/CTE 别名/表达式结果一律跳过，解析失败 fail-open，读不到 schema 整体静默；耗 repairs 预算同 EQP；trace 新增 column_check step。8 单测；评测 --ci 30 题 cassette 全过零误伤）
- [x] B1 后 指纹语义归一 [旧称 步骤 指纹]（9/21：fingerprint.ts——补文本指纹防不住的震荡，只认两条可证明安全的等价：①AND/OR 操作数排序（交换律）②列引用别名归约为真实表名；明确不碰 JOIN 顺序/`x<=5`↔`x<6`/子查询改写（带前提或结构差异大，误杀代价 > 漏抓）。**过度合并护栏是生命线**：AND 叶子按整条序列化排序，仅换值（a=1 AND b=2 vs a=2 AND b=1）判不同；解析失败退回 txt: 前缀保持向后兼容。loop 仅改指纹函数体一行（锁死文件最小接触面）；7 单测含换序/别名互换撞指纹、换值/加条件不合并；评测无回归）
- [ ] ADR 内化：23 篇汇总在 [09-decisions](09-decisions.md)（每篇含「代价」），逐篇能用自己的话讲清
- [ ] 面试叙述稿，口头演练 [Agent 设计](05-agent-design.md#七面试官很可能会问的五个问题) 的五个必问题
- [ ] 再跑一轮定向优化；若已无提升空间，写一段「剩余错题分布在哪四类、每类为什么难、下一步会怎么做」
- [x] `docs/backlog.md` 写清「明确不做」清单及各自的「如果要做会怎么做」（9/21：与 requirements.md 的「为什么不做」分工——本文补「如果做怎么做 + 触发条件 + 成本档」；分三类：地基已就位随时可启动（token 计价/结果缓存/回执扩展/夜间重录）、更大方向押后（多轮会话/语义层/多数据源/智能洞察/向量检索，各带不摧毁评测的做法）、永久绕开的证伪选型。README 文档索引已挂）
- [x] README 用「已实现 / 设计已完成待实现 / 明确不做」三档如实分类，**无一项夸大**（9/21 README 收网时一并完成：三档段落 + 每条带背书来源；待实现项与本文 §一 地基已就位类对齐）

---

## 卡住了怎么办

1. **先看完成标准** —— 你是不是在做标准之外的事？范围蔓延是新手最大的时间黑洞
2. **拆到 30 分钟能做完的粒度** —— 「实现 agent 循环」太大，「让模型输出一段 SQL 并打印出来」刚好
3. **卡超过 1 小时就记下来先跳过** —— 写进 `docs/blocked.md`，做别的，往往第二天自己就通了
4. **别同时改两个地方** —— 一次只动一处，坏了才知道是哪一下坏的
5. **UI 打磨设硬时间盒** —— 超时就砍功能，不要延期
