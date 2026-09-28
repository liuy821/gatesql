/**
 * 量级校验（8d，docs/05 C1(d)）：金额聚合结果与「去掉业务过滤、保留时间
 * 范围」的控制总数对比 —— 结果占比 >100%（超过同范围无过滤的控制总数，
 * 逻辑不可能，疑似口径/JOIN 错误）→ fail，由 loop 降级未核验。
 *
 * 设计要点：
 *   - 控制查询必须保留时间条件。时间范围是问题的口径而非业务过滤——若连时间
 *     也剥掉，「问某一天的销售额」会对比全库总额，正常答案必然 <1%，全是误报。
 *   - 只对「单一 SUM、无 GROUP BY」表态。AVG 与分组结果的占比没有明确语义，
 *     宁可 skip 也不猜。多列/多聚合同样 skip。
 *   - 结果为 NULL / 非数值时不表态——空集形态由 C1 的空集体检负责，不越界。
 *   - **9/28 修订：移除了原 <1%「过滤后所剩无几」分支**。实测「孙明强一共
 *     消费了多少」这类单实体问题，答案天然只占总量的几百分之一，该分支必然
 *     误报 → 单实体类问题永远未核验。启发式 lower bound 的误伤面大于收益，
 *     删除；>100% 是逻辑不可能，保留。（实测案例：r_801ab85f，占比 0.17% 误报）
 */

import { DatabaseSync } from "node:sqlite";

import { Parser } from "node-sql-parser";

import { splitWhere } from "@/lib/sql/probe";

export type MagnitudeVerdict =
  | { status: "skip"; reason: string }
  | { status: "ok"; ratio: number }
  | { status: "fail"; ratio: number; detail: string };

const MAX_RATIO = 1; // >100%：超过同范围无过滤控制总数，逻辑不可能

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

const TIME_COLUMN = /created_at|registered_at/i;

interface SumShape {
  sumCount: number;
  aggCount: number;
  hasAvg: boolean;
  hasGroupBy: boolean;
}

/** 解析 AST 并统计聚合形态：SUM 个数、总聚合数、是否含 AVG、是否分组 */
function analyze(sql: string): SumShape | null {
  let ast: unknown;
  try {
    ast = new Parser().astify(sql, { databaseType: "sqlite" } as never);
  } catch {
    return null;
  }
  if (!isRecord(ast) || ast.type !== "select") return null;

  const shape: SumShape = { sumCount: 0, aggCount: 0, hasAvg: false, hasGroupBy: false };
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!isRecord(node)) return;
    if (node.type === "aggr_func" && typeof node.name === "string") {
      shape.aggCount++;
      const name = node.name.toUpperCase();
      if (name === "SUM") shape.sumCount++;
      if (name === "AVG") shape.hasAvg = true;
    }
    Object.values(node).forEach(walk);
  };
  walk(ast);
  shape.hasGroupBy = ast.groupby !== null && typeof ast.groupby === "object";
  return shape;
}

/**
 * 构造控制查询：剥掉 WHERE 里的业务过滤（status/channel/level 等），保留时间条件，
 * JOIN ON 原样保留。无 WHERE 时返回 null（不存在业务过滤，无需对比）。
 * checkMagnitude 与回执的排除金额合计共用此逻辑，保证两处口径一致。
 */
export function buildControlQuery(sql: string): string | null {
  const w = splitWhere(sql);
  if (!w) return null;
  const kept = w.conds.filter((c) => TIME_COLUMN.test(c));
  return (kept.length > 0 ? `${w.prefix.trim()} WHERE ${kept.join(" AND ")}` : w.prefix.trim()) + w.tail;
}

export function checkMagnitude(input: {
  sql: string;
  columns: string[];
  rows: unknown[][];
  shopDbPath: string | null;
}): MagnitudeVerdict {
  const shape = analyze(input.sql);
  if (!shape) return { status: "skip", reason: "SQL 无法解析" };
  if (shape.hasGroupBy) return { status: "skip", reason: "分组结果不做量级对比" };
  if (shape.aggCount !== 1 || shape.sumCount !== 1 || shape.hasAvg) {
    return { status: "skip", reason: "非单一 SUM 聚合，占比无明确语义" };
  }

  // 结果值：取第一行第一个格子。NULL / 非数值交给空集体检，这里不表态。
  const cell = input.rows[0]?.[0];
  const value = typeof cell === "number" ? cell : Number(cell);
  if (!Number.isFinite(value)) {
    return { status: "skip", reason: "结果非数值（空集形态由其他检查负责）" };
  }

  // 控制查询：剥掉 WHERE 里的业务过滤（status/channel/level 等），保留时间条件
  const controlSql = buildControlQuery(input.sql);
  if (!controlSql) return { status: "skip", reason: "无 WHERE 子句，不存在业务过滤，无需对比" };

  if (!input.shopDbPath) return { status: "skip", reason: "无数据库连接" };
  let control: number | null = null;
  try {
    const db = new DatabaseSync(input.shopDbPath, { readOnly: true });
    try {
      const row = db.prepare(controlSql).get() as Record<string, unknown> | undefined;
      const raw = row ? Object.values(row)[0] : null;
      const n = typeof raw === "number" ? raw : Number(raw);
      if (Number.isFinite(n)) control = n;
    } finally {
      db.close();
    }
  } catch {
    return { status: "skip", reason: "控制查询执行失败，不表态" };
  }
  if (control === null || control <= 0) {
    return { status: "skip", reason: "控制总数为 0 或非数值，无对比基准" };
  }

  const ratio = value / control;
  if (ratio > MAX_RATIO) {
    return {
      status: "fail",
      ratio,
      detail: `结果 ${value} 超过同范围无过滤控制总数 ${control}（占比 ${(ratio * 100).toFixed(1)}%），逻辑不可能，疑似口径或 JOIN 错误`,
    };
  }
  return { status: "ok", ratio };
}
