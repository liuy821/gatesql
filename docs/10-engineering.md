# 工程规范

## 一、TypeScript

- **严格模式，禁止 `any`**。确实需要逃逸时用 `unknown` + 类型守卫，并写注释说明为什么
- 所有跨边界的数据（HTTP 请求体、LLM 输出、SSE 事件、环境变量）用 **Zod 定义 schema**，不要裸对象
- 类型定义放 `src/types/`，与 [接口约定](03-api-contract.md) 保持一致；SSE 事件类型是唯一契约，定义在 `src/lib/events.ts`
- 优先 `type` 而非 `interface`（除非需要声明合并）
- 导出函数必须有显式返回类型

## 二、目录与命名

- 组件放 `src/components/`，**一个组件一个文件**，文件名用 kebab-case（`chart-panel.tsx`），组件名用 PascalCase
- 业务逻辑放 `src/lib/`，按领域分子目录（`agent/` `sql/` `db/` `verify/`）
- **`src/app/` 下只放路由和薄薄的一层编排**，业务逻辑不写在 `page.tsx` 或 `route.ts` 里
- 测试文件与被测文件同名加 `.test.ts`，放 `tests/` 下的对应子目录

## 三、测试策略

**不追求覆盖率数字。** 测试资源只押在「写错了会静默产生错误结论」的地方：

| 必须有测试 | 为什么 |
|---|---|
| `tests/security/` —— ≥30 条攻击语料 | 漏一条就是删库 |
| 结果等价比对器 | 静默误判会让整套准确率变成谎言 |
| 8 条口径规则的正反 fixture | 假阳性会把正确 SQL 打回 |
| 时间解析（`resolveTimeRange`） | 跨年跨季度边界错得隐蔽 |
| `reduceEvents` | 纯函数，喂假事件数组即可测，成本极低 |

**不做**：Playwright 全量 E2E（最多留一个「能提问并拿到结果」的冒烟用例）、UI 组件快照测试、为了覆盖率补的无意义用例。

### agent 这类非确定性输出怎么测

不测「模型输出对不对」（那是评测体系的事），只测**确定性的部分**：

- 给定一个固定的 SQL 字符串，guard / lint / EQP 的判定是否符合预期
- 给定一组固定的失败历史，重试提示词是否按六分类正确分流
- 给定两个语义等价的 SQL，指纹是否相同

模型相关的回归靠 cassette replay + 30 题评测集，见 [评测体系](06-evaluation.md)。

## 四、Git

- **一次提交只做一件事**，提交信息用中文写清楚做了什么和为什么
- 评测轮次的提交在信息里带上分数：`第2轮优化：口径规则注入提示词，总准确率 66.7% → 76.7%`
- 评测集冻结后打 tag：`git tag evalset-frozen-v1`
- `.env.local`、`data/*.db`、`fixtures/llm/` 的体积控制见 `.gitignore`

**`.gitattributes` 必须有**：

```
* text=auto eol=lf
```

> 为什么：CRLF 进容器会让 entrypoint 脚本报 `exec format error`，而这个错误信息**完全无法自解释**，能耗掉你半天。

## 五、环境变量

全部通过 Zod 校验后读取（`src/lib/env.ts`），缺失或格式错在启动时就报错，不要等到运行时。

| 变量 | 说明 | 默认 |
|---|---|---|
| `LLM_BASE_URL` | OpenAI 兼容接口地址 | —— |
| `LLM_API_KEY` | 模型密钥 | 缺失时自动进 replay 模式 |
| `LLM_MODEL` | 模型名 | —— |
| `LLM_MODE` | `live` / `record` / `replay` | 有 key 时 `live`，无 key 时 `replay` |
| `LLM_WIRE` | 线上协议 `auto` / `responses` / `chat_completions` | `auto` 按 baseURL 推断（含 `/coding/` → responses） |
| `SHOP_DB_PATH` | 被分析库路径 | `./data/shop.db` |
| `APP_DB_PATH` | 应用库路径 | `./data/app.db` |
| `AS_OF_DATE` | 覆盖默认时钟 | `max(orders.created_at)` |
| `MAX_REPAIRS` | 口径类重试上限 | `2` |
| `MAX_EXEC_RETRIES` | 执行类重试上限 | `2` |
| `MAX_LLM_CALLS` | 单 run 模型调用上限 | `6` |
| `WALL_CLOCK_MS` | 单 run 墙钟上限 | `45000` |
| `QUERY_TIMEOUT_MS` | 单条 SQL 超时 | `5000` |
| `MAX_ROWS` | 返回行数上限 | `1000` |
| `DAILY_TOKEN_BUDGET` | 全局日预算，超限降级 replay | —— |
| `AUTH_PASSWORD` | 单口令 | —— |
| `JWT_SECRET` | 签名密钥 | —— |

**密钥只从环境变量读，绝不出现在代码里。** `.env.local` 已被 gitignore，仓库里只留 `.env.example`。

### 切换模型供应商

换供应商**不碰任何业务代码** —— 只改三个环境变量（含协议自动推断，见 `src/lib/agent/providers.ts`）：

```bash
# DeepSeek 示例
LLM_BASE_URL=https://api.deepseek.com/v1
LLM_MODEL=deepseek-chat
# (LLM_API_KEY 换成你的)

# 火山 Coding Plan（默认，含 /coding/ 自动走 responses 协议）
LLM_BASE_URL=https://ark.cn-beijing.volces.com/api/coding/v3
LLM_MODEL=ark-code-latest
```

**注意**：cassette 键包含协议类型（`wire`），切换供应商后旧 cassette 不会命中 —— 这是故意的，防止「换模型却复用旧响应」的假提升。

## 六、本机环境注意事项（Windows + GBK）

这台机器的系统 ANSI 代码页是 **936（GBK）**，编码问题高发。以下每一条都是真实踩过的坑：

### 文件编码

- **所有文件读写显式指定 UTF-8**，不要依赖默认值
- **项目文件一律由编辑器或 Node 写入，绝不用 PowerShell 重定向生成** —— `>` 和 `Out-File` 的编码行为不一致，`Set-Content` 默认走 ANSI
- `.env` 里不写中文
- CSV 导出**必须加 UTF-8 BOM**，否则 Excel 打开中文是乱码 —— 这是业务人员一眼就判定产品不可用的真实 bug

### 路径

- 路径不要写死，用相对路径或环境变量
- **项目放在 `D:\code\` 而不是用户目录下** —— 用户名含中文会引发一类隐蔽的编码问题（GBK 字节被当成 UTF-8 解码，`刘远` 会变成 `��Զ`）
- 路径里不要有空格

### Node 与 Python

- Python 解释器在 `D:\anaconda\anaconda3.12\python.exe`
- 已设用户级环境变量 `PYTHONUTF8=1` 和 `PYTHONIOENCODING=utf-8`，让 Python 默认按 UTF-8 读写文件。副作用：读 GBK 编码的老文件需要显式写 `encoding='gbk'`

### Next.js 开发期

- **React StrictMode 会让 `useEffect` 跑两次**，导致 SSE 开两条连接、LLM 付两次费。必须用 `AbortController` + ref 哨兵处理。这个坑只在 dev 出现，极易被误判成后端 bug

## 七、本地开发流程

```bash
pnpm dev                # 开发服务器
pnpm test               # Vitest
pnpm test -- --watch    # 监听模式
pnpm eval               # 全量 30 题评测
pnpm eval:quick         # 10 题子集，90 秒
pnpm build              # 生产构建（改完类型定义务必跑一次）
docker compose up       # 完整容器验证
```

日常开发用便宜模型，**只在正式记录基线时切正式模型**。

## 八、代码审查要点

代码审查重点看这几处：

1. **有没有绕过契约** —— 前端是不是自己定义了一套事件类型而不是 import `events.ts`
2. **有没有出现 `db.exec(`** —— agent 代码路径上出现即为严重问题
3. **文件读写有没有写编码**
4. **错误路径有没有推 `done` 事件** —— 任何分支下都必须发
5. **有没有在 SSE 热路径上同步写库** —— step 应该内存缓冲后批量 flush
6. **新增的口径规则有没有配正反两个 fixture**
7. **提示词改动有没有跑评测** —— 改了提示词不跑评测等于没改

## 九、改动纪律

- `src/lib/agent/loop.ts` 和 `src/lib/sql/guard.ts` 是全项目的核心实现，改动前先读 [Agent 设计](05-agent-design.md) 与 [安全设计](07-security.md)，改完逐行 review
- 动手前引用具体契约（「按 `docs/03-api-contract.md` 实现桩接口」），而不是「把后端实现了」这类大而空的任务描述
- 每次改完自己复述一遍实现思路 —— 复述不出来的地方，就是还没吃透的地方
