/**
 * GateSQL 的 agent 主循环（全项目核心，作者必须逐段理解并会复述）。
 *
 * 装配关系：把 2A-2F 的零件按 docs/05-agent-design.md 的三段 4-6-4 串起来。
 * 所有零件都已实现并有测试；本文件只负责「流程、预算、重试、可观测」。
 *
 * 三个面试必问的设计点，答案都在这份代码里：
 *   1. 重试几次？—— 不是死记「3 次」，是双预算独立计数（repairs 管口径/预检类，
 *      execRetries 管执行报错类）+ 全局 maxLlmCalls 上限。
 *   2. 怎么防死循环？—— 指纹环路检测：修出来的 SQL 若和之前某次「等价」，
 *      就强制换策略；再次命中同一指纹 → 终止，绝不无限重试。
 *   3. 超预算怎么办？—— 优雅降级：保住数据正确性 > 结论 > 图表。
 *
 * 本文件不调任何框架，就是一个 async 函数 + 穷举的状态机。
 */

import { createHash } from "node:crypto";

import { callLlm } from "@/lib/agent/llm";
import {
  buildChartPrompts,
  buildSelfCheckPrompts,
  buildSqlGenSystemPrompt,
  buildSqlGenUserParts,
  type RepairRecord,
} from "@/lib/agent/prompt";
import { runHealthChecks } from "@/lib/agent/health";
import { findAmbiguity, formatClarifyReason } from "@/lib/agent/clarify";
import { formatFewshotExamples, retrieveFewshots } from "@/lib/agent/fewshot";
import { buildSchemaContext } from "@/lib/agent/schema-context";
import { resolveTimeRange, isBeyondWatermark } from "@/lib/agent/time";
import { detectIncompletePeriod } from "@/lib/agent/period";
import { createRun, finishRun, insertStep, openAppDb, type NewStepInput } from "@/lib/db/app";
import { resolveDefaultAsOf } from "@/lib/db/schema";
import { getConfig } from "@/lib/env";
import type { GateSqlEvent, ChartSpec } from "@/lib/events";
import { explainCost } from "@/lib/sql/explain";
import { semanticFingerprint } from "@/lib/sql/fingerprint";
import { checkColumnReferences, listTableColumns } from "@/lib/sql/schema-check";
import { QueryTimeoutError, SqlExecutor } from "@/lib/sql/executor";
import { guardSql } from "@/lib/sql/guard";
import { buildReceipt } from "@/lib/sql/receipt";
import { lintRules, type LintHints } from "@/lib/sql/lint";

/* ------------------------------------------------------------------ */
/* 输入 / 输出                                                         */
/* ------------------------------------------------------------------ */

export interface RunAgentDeps {
  question: string;
  /** 覆写默认时钟（评测复现用） */
  asOfDate?: string;
  /** 把一个事件推给前端（由 route 负责编码为 SSE 帧并落库） */
  emit(event: GateSqlEvent): void;
  /** 记录一条执行步骤（内存缓冲，run 结束时统一 flush） */
  trace(step: Omit<NewStepInput, "runId">): void;
}

export interface RunSummary {
  runId: string;
  finalStatus: string;
  verdict: "verified" | "unverified" | "refused" | null;
  attempts: number;
  llmCalls: number;
  elapsedMs: number;
  inputTokens: number;
  outputTokens: number;
}

/* ------------------------------------------------------------------ */
/* 结构化输出的 JSON Schema（交给 LLM 的 json_schema）                  */
/* ------------------------------------------------------------------ */

const SQL_GEN_SCHEMA = {
  type: "object",
  properties: {
    sql: { type: "string", description: "只读查询语句，目标 SQLite" },
    citedRules: { type: "array", items: { type: "string" }, maxItems: 8 },
    unanswerable: { type: "boolean" },
    unanswerableReason: { type: "string", description: "unanswerable=true 时的原因" },
  },
  required: ["sql", "citedRules", "unanswerable"],
} as const;

const CHART_SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["bar", "line", "pie", "none"] },
    x: { type: "string" },
    y: { type: "array", items: { type: "string" } },
    title: { type: "string" },
    summary: { type: "string", description: "定性结论，不得出现任何数字断言" },
  },
  required: ["kind", "x", "y", "title", "summary"],
} as const;

/** 自检审计员（SELF_CHECK=on 时才调用）：只报疑、不直接改 SQL */
const SELF_CHECK_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["pass", "revise"] },
    reason: { type: "string", description: "verdict=revise 时的具体疑点，指明错在哪个子句" },
  },
  required: ["verdict", "reason"],
} as const;

/* ------------------------------------------------------------------ */
/* 轻量工具                                                            */
/* ------------------------------------------------------------------ */

function newRunId(): string {
  return `r_${createHash("sha1").update(crypto.randomUUID()).digest("hex").slice(0, 8)}`;
}

/**
 * SQL 指纹：委托 semanticFingerprint 做语义归一（条件换序 / 别名互换也撞指纹）。
 * 解析失败时该模块内部退回文本归一，行为向后兼容（见 fingerprint.ts 的两条安全等价）。
 */
function fingerprint(sql: string): string {
  return semanticFingerprint(sql);
}

/** 从问题里提取 hint（R6/R7 需要它，见 lint.ts 的契约） */
function extractHints(question: string): LintHints {
  return {
    timeKeywords: /(近\s*\d+\s*天|上个月|本月|这个月|去年|去年同期|季度|上半年|下半年|[0-9]{4}年)/.test(question)
      ? ["time"]
      : [],
    rankKeywords: /(最|排名|排行|前\s*(\d+|N)|TOP)/.test(question) ? ["rank"] : [],
  };
}

/** 去掉 JSON 响应里可能裹着代码围栏 / 前后散文的噪音，再尝试解析 */
function tryParseJson<T>(text: string): T | null {
  let candidate = text.replace(/^```(?:json)?/i, "").replace(/```$/g, "").trim();
  // 模型偶尔会在 JSON 前/后多写一行注释或说明 —— 直接截取第一个 { ... } 块
  const brace = candidate.match(/\{[\s\S]*\}/);
  if (brace) candidate = brace[0];
  try {
    return JSON.parse(candidate) as T;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 主循环                                                              */
/* ------------------------------------------------------------------ */

export async function runAgent(deps: RunAgentDeps): Promise<RunSummary> {
  const env = getConfig();
  const startedAt = Date.now();

  const runId = newRunId();
  const asOf = deps.asOfDate ?? env.AS_OF_DATE ?? resolveDefaultAsOf(env.SHOP_DB_PATH);

  // —— 预算（面试点 1）——
  const budgets = {
    repairs: 2, // B3 lint block / B4 列名核对 / B5 EQP 拒绝 共享
    execRetries: 2, // B6 SQL 执行报错 独立计数
    wallClockMs: 45_000,
  };
  let llmCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  // —— 运行期状态（确保 finally 一定能安全收尾）——
  const seenFingerprints = new Set<string>();
  let sameFingerprintHits = 0;
  /** 连续 SCHEMA_PARSE_FAILED 计数 —— 连续失败会有明确结局而不是烧光预算 */
  let consecutiveParseFailures = 0;
  /** 自检审计每次运行最多一次（SELF_CHECK=on），防「审计→重写→再审计」成本放大 */
  let selfCheckUsed = false;
  /** 最近一次模型原始回复（结构化解析失败时用来给用户一个可读的说明） */
  let lastModelText = "";
  let attempts = 0;
  let finalStatus: string = "ok";
  let verdict: RunSummary["verdict"] = null;
  const verdictReasons: string[] = [];
  let warnSeen = false;
  /** warnSeen 已带专属理由（空集聚合分支），C2 不再补泛化理由 */
  let warnReasoned = false;
  let success: { columns: string[]; rows: unknown[][] } | null = null;
  let lastSql: string | null = null;
  const stepBuffer: Array<Omit<NewStepInput, "runId">> = [];

  // —— 装配：DB 与执行器（run 结束统一释放）——
  const appDb = openAppDb(env.APP_DB_PATH);
  const executor = new SqlExecutor(env.SHOP_DB_PATH, env.QUERY_TIMEOUT_MS);
  const trace = (step: Omit<NewStepInput, "runId">) => void stepBuffer.push(step);

  // A1 建 run（run_started 事件与 runs 行在 try 之前写入，保证任何分支都有 run_id）
  deps.emit({ type: "run_started", runId, asOfDate: asOf });
  createRun(appDb, {
    id: runId,
    question: deps.question,
    asOfDate: asOf,
    llmMode: env.LLM_MODE ?? (env.LLM_API_KEY ? "live" : "replay"),
    createdAt: new Date().toISOString(),
  });

  try {
    /* ============ A2：时间归一（不调 LLM） ============ */

    const resolution = resolveTimeRange(deps.question, asOf);
    let question = deps.question;
    if (resolution) {
      question = resolution.rewrittenQuestion;
      deps.emit({
        type: "time_resolved",
        expression: resolution.expression,
        from: resolution.from,
        to: resolution.to,
        display: resolution.display,
      });
    }

    /* ============ A3：上下文装配（不调 LLM） ============ */

    const ctx = buildSchemaContext(question, env.SHOP_DB_PATH);
    // few-shot A/B 开关（FEW_SHOT，默认 off；docs/05 第四节：≤2 条、低于阈值宁可不给）
    const fewshots = env.FEW_SHOT === "on" ? retrieveFewshots(appDb, question, ctx.selectedTables) : [];
    const fewshotIds: string[] = fewshots.map((f) => f.id);

    // —— A4 提前拒答闸门 · 子检查①：口径歧义澄清（docs/08 5A，确定性词典，零 token）——
    // 命中则直接拒答并附澄清选项，不进 B 段循环：歧义题「先算再问」会交付武断数字，
    // 正确行为是先问口径（E3/E4 考的正是这个）
    const ambiguity = findAmbiguity(question);
    if (ambiguity) {
      verdict = "refused";
      finalStatus = "ambiguous";
      verdictReasons.push(formatClarifyReason(ambiguity));
    }
    // —— A4 提前拒答闸门 · 子检查②：时间窗口整体越过数据水位（6G 后续优化，0 次模型调用）——
    // 问了一个数据库里还不存在的时段：跑 LLM+探针只会得到空集归因，
    // 在源头拒答理由更准、0 token。部分重叠的窗口照常执行（C1 出水位标记）
    if (!ambiguity && isBeyondWatermark(resolution, asOf)) {
      verdict = "refused";
      finalStatus = "beyond_watermark";
      verdictReasons.push(
        `你问的时间范围（${resolution!.display}）在数据覆盖范围（截至 ${asOf}）之外，无数据可查`,
      );
    }
    deps.emit({ type: "context_built", tables: ctx.selectedTables, fewshotIds });
    const hints = extractHints(question);
    // 列名核对的真实表列清单（每 run 读一次）。读不到 = 空 Map = 核对整体静默跳过
    // （fail-open：新增检查层绝不能成为新的崩溃源）
    let schemaColumns: Map<string, Set<string>>;
    try {
      schemaColumns = listTableColumns(env.SHOP_DB_PATH);
    } catch {
      schemaColumns = new Map();
    }

    // 重试上下文只追加不重写：携带全部历史失败的结构化摘要
    const repairHistory: RepairRecord[] = [];

    /* ============ B1~B6：生成 → 四道关卡 → 执行（全项目唯一的重试循环） ============ */
    // A4 两道子检查命中时循环体一次都不进（0 次模型调用，直达 C2 拒答）
    while (!ambiguity && verdict === null) {
      // —— 循环守卫：墙钟 / LLM 调用数 ——
      if (Date.now() - startedAt > budgets.wallClockMs) {
        finalStatus = "BUDGET_EXCEEDED";
        break;
      }
      if (llmCalls >= 6) {
        finalStatus = "BUDGET_EXCEEDED";
        break;
      }

      const attempt = ++attempts;
      const t0 = Date.now();

      // —— B1：生成 SQL（prompt 构建抽至 prompt.ts，逐字节等价以保住 cassette 键）——
      const fewshotText = fewshots.length > 0 ? formatFewshotExamples(fewshots) : null;
      const system = buildSqlGenSystemPrompt(ctx.card, fewshotText);
      const userParts = buildSqlGenUserParts(question, repairHistory, sameFingerprintHits >= 1);

      const gen = await callLlm(
        [
          { role: "system", content: system },
          { role: "user", content: userParts.join("\n") },
        ],
        { jsonSchema: SQL_GEN_SCHEMA },
      );
      llmCalls++;
      inputTokens += gen.inputTokens;
      outputTokens += gen.outputTokens;
      lastModelText = gen.text;

      // 结构化解析：失败走 SCHEMA_PARSE_FAILED（计入 llmCalls，不计入 repairs）
      const parsed = tryParseJson<{ sql?: unknown; unanswerable?: unknown; unanswerableReason?: unknown }>(gen.text);

      // 关键判断：sql 为空有两种可能 ——
      // ① unanswerable=true 时本来就允许空 sql（模型诚实地说「答不了」）→ 接受并拒答
      // ② 真正缺 sql 字段 / 解析失败 → 才走 parse-fail 重试
      if (parsed && (typeof parsed.sql === "string" ? !parsed.sql.trim() : !("sql" in parsed))) {
        if (parsed.unanswerable === true) {
          verdict = "refused";
          finalStatus = "unanswerable";
          verdictReasons.push(
            typeof parsed.unanswerableReason === "string" && parsed.unanswerableReason
              ? parsed.unanswerableReason
              : "数据源中不存在能回答该问题的数据",
          );
          break;
        }
      }
      if (!parsed || typeof parsed.sql !== "string" || !parsed.sql.trim()) {
        repairHistory.push({ attempt, kind: "SCHEMA_PARSE_FAILED", detail: "模型输出的 JSON 无法解析或无 sql 字段" });
        consecutiveParseFailures++;
        if (consecutiveParseFailures >= 3) {
          verdict = "refused";
          finalStatus = "SCHEMA_PARSE_FAILED";
          const snippet = lastModelText.replace(/\s+/g, " ").trim().slice(0, 120);
          verdictReasons.push(
            `暂时无法生成可执行的查询：模型连续 3 次未返回结构化 SQL` +
              (snippet ? `（模型最后一次回复大意：“${snippet}…”）` : "") +
              `。若问题涉及数据库中不存在的表或字段，可改用其它问法；当前可查询：customers / products / orders / order_items。`,
          );
          break;
        }
        continue;
      }
      consecutiveParseFailures = 0;

      if (parsed.unanswerable === true) {
        verdict = "refused";
        verdictReasons.push(
          typeof parsed.unanswerableReason === "string" && parsed.unanswerableReason
            ? parsed.unanswerableReason
            : "数据源中不存在能回答该问题的数据",
        );
        break;
      }

      // 模型常把结尾分号写进 SQL 字符串里，guard 会把带尾分号的语句判为多语句。
      // 这是正常防御；正确修法是在入口处归一化（去尾部空白与分号），而不是放宽 guard。
      const sql = parsed.sql.trim().replace(/;+\s*$/, "");
      deps.emit({ type: "sql_generated", attempt, sql, citedRules: [] });
      trace({
        kind: "llm_call",
        seq: attempt,
        startedAt: t0,
        endedAt: Date.now(),
        status: "ok",
        attributes: { prompt: system + "\n\n" + userParts.join("\n"), completion: gen.text, inputTokens: gen.inputTokens, outputTokens: gen.outputTokens },
      });

      // —— 指纹环路检测（面试点 2）——
      const fp = fingerprint(sql);
      if (seenFingerprints.has(fp)) {
        sameFingerprintHits++;
        if (sameFingerprintHits >= 2) {
          verdict = "unverified";
          verdictReasons.push("模型在多个等价错误写法间反复震荡，终止重试");
          break;
        }
      }
      seenFingerprints.add(fp);

      // —— B2：安全（fail-closed；安全拒绝不重试，直接终止）——
      const guard = guardSql(sql, env.MAX_ROWS);
      if (!guard.ok) {
        finalStatus = "UNSAFE_SQL";
        trace({ kind: "guard", seq: attempt, startedAt: t0, endedAt: Date.now(), status: "failed", attributes: { detail: guard.detail ?? guard.reason } });
        deps.emit({ type: "error", code: "UNSAFE_SQL", message: "SQL 安全检查未通过", detail: guard.detail });
        break;
      }

      // —— B3：口径 lint（fail-open；block 消耗 repairs 预算）——
      const lintResult = lintRules(guard.sql, hints);
      deps.emit({ type: "lint_result", attempt, violations: lintResult.violations });
      trace({
        kind: "lint",
        seq: attempt,
        startedAt: t0,
        endedAt: Date.now(),
        status: lintResult.parseFailed ? "failed" : "ok",
        attributes: { violations: lintResult.violations, parseFailed: lintResult.parseFailed },
      });

      const blockViolations = lintResult.violations.filter((v) => v.level === "block");
      const warnViolations = lintResult.violations.filter((v) => v.level === "warn");
      if (warnViolations.length > 0) warnSeen = true;

      if (blockViolations.length > 0) {
        const blame = blockViolations.map((v) => v.missingPredicate).join("；");
        if (budgets.repairs > 0) {
          budgets.repairs--;
          repairHistory.push({ attempt, kind: "RULE_VIOLATION", detail: blame });
          continue;
        }
        // 预算耗尽仍未修复口径 —— 拒答（三态之一），绝不在错误口径下出数字
        verdict = "refused";
        verdictReasons.push(`口径规则未能在预算内修复：${blame}`);
        break;
      }

      // —— B4：列名静态核对（6G②，零误报纪律：只核对带真实表前缀的引用）——
      // 带前缀的错列在执行前就拦下，诊断精确到「该表可用列」；无前缀/CTE 一律放行，
      // 数据库报错路径（SQL_FAILED + execRetries）保持原样兜底
      const colCheck = checkColumnReferences(guard.sql, schemaColumns);
      trace({
        kind: "column_check",
        seq: attempt,
        startedAt: t0,
        endedAt: Date.now(),
        status: colCheck.ok ? "ok" : "failed",
        attributes: colCheck.ok ? {} : { detail: colCheck.detail },
      });
      if (!colCheck.ok) {
        if (budgets.repairs > 0) {
          budgets.repairs--;
          repairHistory.push({ attempt, kind: "COLUMN_UNKNOWN", detail: colCheck.detail ?? "列引用不存在" });
          continue;
        }
        verdict = "refused";
        verdictReasons.push(`列名核对未能在预算内通过：${colCheck.detail ?? ""}`);
        break;
      }

      // —— B5：EQP 代价预检（与 lint 同吃 repairs 预算）——
      const cost = explainCost(guard.sql, env.SHOP_DB_PATH);
      trace({ kind: "eqp", seq: attempt, startedAt: t0, endedAt: Date.now(), status: cost.ok ? "ok" : "rejected", attributes: cost.ok ? {} : { reason: cost.reason } });
      if (!cost.ok) {
        if (budgets.repairs > 0) {
          budgets.repairs--;
          repairHistory.push({ attempt, kind: "COST_REJECTED", detail: cost.reason });
          continue;
        }
        finalStatus = "COST_REJECTED";
        deps.emit({ type: "error", code: "COST_REJECTED", message: "查询代价超出安全范围", detail: cost.reason });
        break;
      }

      // —— B3 增强：自检审计（A/B 开关 SELF_CHECK，默认 off；docs/08 第 4 周）——
      // 设计：审计员只报疑、不直接改 SQL —— 疑点走既有修复通道（repairs 预算 + 回喂重生成），
      // 架构上不多开一条「第二生成路径」。每次运行最多审计一次，预算不足时降级未核验放行。
      if (env.SELF_CHECK === "on" && !selfCheckUsed) {
        selfCheckUsed = true;
        const { system: scSystem, user: scUser } = buildSelfCheckPrompts(ctx.card, question, guard.sql);
        const sc = await callLlm(
          [
            { role: "system", content: scSystem },
            { role: "user", content: scUser },
          ],
          { jsonSchema: SELF_CHECK_SCHEMA },
        );
        llmCalls++;
        inputTokens += sc.inputTokens;
        outputTokens += sc.outputTokens;
        trace({
          kind: "llm_call",
          seq: attempt,
          startedAt: t0,
          endedAt: Date.now(),
          status: "ok",
          attributes: {
            phase: "self_check",
            prompt: scSystem + "\n\n" + scUser,
            completion: sc.text,
            inputTokens: sc.inputTokens,
            outputTokens: sc.outputTokens,
          },
        });
        const finding = tryParseJson<{ verdict?: unknown; reason?: unknown }>(sc.text);
        if (finding && finding.verdict === "revise") {
          const reason = typeof finding.reason === "string" && finding.reason ? finding.reason : "审计发现疑点";
          if (budgets.repairs > 0) {
            budgets.repairs--;
            repairHistory.push({ attempt, kind: "SELF_CHECK_FINDING", detail: reason });
            continue; // 回到生成步骤，模型带着审计意见重写（重写产物重新过 guard/lint/EQP）
          }
          warnSeen = true; // 预算耗尽：不重试，但如实降级为未核验
        }
      }

      // —— B6：只读执行（worker 隔离 + 超时放弃，不依赖 terminate）——
      lastSql = guard.sql;
      try {
        const result = await executor.execute(guard.sql);
        success = { columns: result.columns, rows: result.rows };
        deps.emit({
          type: "rows",
          columns: result.columns,
          rows: result.rows,
          rowCount: result.rowCount,
          truncated: result.rowCount >= env.MAX_ROWS,
          elapsedMs: result.elapsedMs,
        });
      } catch (err) {
        if (err instanceof QueryTimeoutError) {
          finalStatus = "TIMEOUT";
          deps.emit({ type: "error", code: "TIMEOUT", message: err.message });
          break;
        }
        const detail = err instanceof Error ? err.message : String(err);
        if (budgets.execRetries > 0) {
          budgets.execRetries--;
          repairHistory.push({ attempt, kind: "SQL_FAILED", detail });
          continue;
        }
        finalStatus = "SQL_FAILED";
        deps.emit({ type: "error", code: "SQL_FAILED", message: "反复执行失败", detail });
        break;
      }

      trace({ kind: "execute", seq: attempt, startedAt: t0, endedAt: Date.now(), status: "ok", attributes: { rows: success.rows.length } });
      break; // 执行成功，离开循环
    }

    /* ============ C1：结果体检（不调 LLM） ============ */
    // 分析逻辑抽至 health.ts（纯函数，可单测）；状态写入与 emit 留在主函数，保持流转集中
    if (success) {
      const h = await runHealthChecks({
        success,
        lastSql,
        maxRows: env.MAX_ROWS,
        shopDbPath: env.SHOP_DB_PATH,
        execute: (sql) => executor.execute(sql),
      });
      if (h.emptyResultFlag) finalStatus = "EMPTY_RESULT";
      if (h.warnSeen) warnSeen = true;
      if (h.warnReasoned) warnReasoned = true;
      for (const r of h.reasons) verdictReasons.push(r);
      deps.emit({
        type: "verification",
        checks: h.checks,
        emptyReason: h.emptyReason,
        incompletePeriod: detectIncompletePeriod(resolution, asOf) ?? undefined,
      });
    }

    /* ============ C2：三态判定 + 回执（不调 LLM） ============ */

    if (!verdict) {
      if (warnSeen || finalStatus !== "ok") {
        verdict = "unverified";
        if (finalStatus !== "ok" && finalStatus !== "EMPTY_RESULT" && finalStatus !== "BUDGET_EXCEEDED") {
          verdictReasons.push(`执行未完成（${finalStatus}）`);
        }
        if (warnSeen && !warnReasoned) {
          verdictReasons.push("存在口径疑点（见 lint / 自检记录），如实降级为未核验");
        }
      } else {
        verdict = "verified";
      }
    }

    const tReceipt = Date.now();
    // 排除金额合计的原料：仅单行结果时取第一格（多行结果的金额列不可定位，诚实跳过）
    let resultValue: number | undefined;
    if (success && success.rows.length === 1) {
      const cell = success.rows[0][0];
      const n = typeof cell === "number" ? cell : Number(cell);
      if (Number.isFinite(n)) resultValue = n;
    }
    const receipt = buildReceipt({
      resolution,
      sql: lastSql,
      asOf,
      shopDbPath: env.SHOP_DB_PATH,
      resultValue,
    });
    deps.emit({ type: "receipt", ...receipt });
    trace({
      kind: "receipt",
      seq: attempts + 200,
      startedAt: tReceipt,
      endedAt: Date.now(),
      status: "ok",
      attributes: {
        pinned: receipt.filters.length > 0,
        filters: receipt.filters.length,
        excluded: receipt.excluded.length,
        fullyTranslated: receipt.fullyTranslated,
      },
    });
    // 回执翻译不全时，即使其他条件都好也必须如实降级为未核验
    if (!receipt.fullyTranslated && verdict === "verified") {
      verdict = "unverified";
      verdictReasons.push("口径回执未能完整翻译，如实降级为未核验");
    }

    deps.emit({
      type: "state",
      verdict,
      reasons: verdictReasons,
      clarifications:
        verdict === "refused"
          ? ambiguity
            ? ambiguity.options // 口径歧义：给候选口径让用户选
            : [{ label: "查看可查询的表", description: "customers / products / orders / order_items" }]
          : undefined,
    });

    /* ============ C3：图表 + 结论（LLM #2，可被预算砍掉） ============ */

    if (success && verdict !== "refused" && llmCalls < 6) {
      const { system: sys, user: content } = buildChartPrompts(ctx.card, success.columns, success.rows);

      // 总结调用失败时允许自动重试一次（对偶预算：不占 repairs / execRetries）
      for (let s = 0; s < 2 && llmCalls < 6; s++) {
        const s0 = Date.now();
        try {
          const res = await callLlm(
            [
              { role: "system", content: sys },
              { role: "user", content },
            ],
            { jsonSchema: CHART_SCHEMA },
          );
          llmCalls++;
          inputTokens += res.inputTokens;
          outputTokens += res.outputTokens;
          trace({ kind: "llm_call", seq: attempts + 100 + s, startedAt: s0, endedAt: Date.now(), status: "ok", attributes: { stage: "summarize", prompt: sys + "\n\n" + content, completion: res.text } });

          const parsed = tryParseJson<{ kind?: unknown; x?: unknown; y?: unknown; title?: unknown; summary?: unknown }>(res.text);
          if (!parsed) continue; // 解析失败 → 重试一次
          const kind = (["bar", "line", "pie", "none"].includes(String(parsed.kind)) ? parsed.kind : "none") as ChartSpec["kind"];
          const x = typeof parsed.x === "string" ? parsed.x : "";
          const title = typeof parsed.title === "string" ? parsed.title : "";
          const y = Array.isArray(parsed.y) ? parsed.y.filter((v): v is string => typeof v === "string") : [];
          deps.emit({
            type: "chart",
            spec: { kind, x, y, title },
          });
          if (typeof parsed.summary === "string" && parsed.summary) {
            deps.emit({ type: "text_delta", delta: parsed.summary });
          }
          break; // 成功即结束
        } catch {
          // 超时 / 网络抖动：重试一次后放弃（数字已在表格与回执里）
        }
      }
    }
  } finally {
    /* ============ C4：收尾（任何分支都到达这里） ============ */

    const elapsedMs = Date.now() - startedAt;
    deps.emit({
      type: "done",
      runId,
      elapsedMs,
      attempts,
      llmCalls,
      tokens: { input: inputTokens, output: outputTokens },
      // 成本折算（按 token × 单价）属 P2；第 4 周接入计价表前先记 0
      costCny: 0,
    });

    finishRun(appDb, {
      id: runId,
      verdict: verdict ?? "unverified",
      verdictReasons,
      finalStatus,
      attempts,
      llmCalls,
      inputTokens,
      outputTokens,
      elapsedMs,
    });

    executor.close();
    for (const step of stepBuffer) insertStep(appDb, { ...step, runId });
    appDb.close();
  }

  return {
    runId,
    finalStatus,
    verdict,
    attempts,
    llmCalls,
    elapsedMs: Date.now() - startedAt,
    inputTokens,
    outputTokens,
  };
}