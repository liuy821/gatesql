"use server";

/**
 * 5G 的两个 Server Action：
 *   saveReportFromRun   —— 已核验的问答一键固化为报表（存 SQL，不存结果）
 *   saveCorrectionFromEdit —— 人工改对的 SQL 安全校验后重跑并入 corrections（verified）
 *
 * 安全边界：入库前一律过 guardSql；corrections 是 few-shot 的样本源，
 * 脏样本入库会反向污染提示词，所以必须人工触发 + 代码校验双保险。
 */

import { revalidatePath } from "next/cache";

import { DatabaseSync } from "node:sqlite";

import { reduceEvents } from "@/lib/reduce-events";
import { guardSql } from "@/lib/sql/guard";
import { getEventsForRun, openAppDb, saveCorrection, saveReport } from "@/lib/db/app";

export interface ActionResult {
  ok: boolean;
  message: string;
}

/** 从一次已核验的问答固化报表：只存 SQL 与图表配置，不存结果 */
export async function saveReportFromRun(runId: string): Promise<ActionResult> {
  const db = openAppDb();
  try {
    const events = getEventsForRun(db, runId);
    if (events.length === 0) return { ok: false, message: "找不到该 run 的事件" };
    const state = reduceEvents(events);
    const lastAttempt = state.attempts[state.attempts.length - 1];
    if (!lastAttempt) return { ok: false, message: "该 run 没有可固化的 SQL" };
    if (state.verdict !== "verified") return { ok: false, message: "仅「已核验」的答案可存为报表" };

    const runRow = db.prepare("SELECT question FROM runs WHERE id = ?").get(runId) as { question: string } | undefined;
    const id = `rep_${crypto.randomUUID().slice(0, 8)}`;
    saveReport(db, {
      id,
      name: runRow?.question?.slice(0, 60) ?? id,
      sql: lastAttempt.sql,
      chartSpec: state.chart,
      sourceRunId: runId,
      createdAt: new Date().toISOString(),
    });
    revalidatePath("/reports");
    return { ok: true, message: id };
  } finally {
    db.close();
  }
}

/** 人工改对的 SQL：guard 校验 + 只读重跑确认可行 → 存为 verified 纠正样本 */
export async function saveCorrectionFromEdit(runId: string, editedSql: string): Promise<ActionResult> {
  const sql = editedSql.trim().replace(/;+\s*$/, "");
  if (sql.length === 0) return { ok: false, message: "SQL 为空" };
  const env = (await import("@/lib/env")).getConfig();
  const guard = guardSql(sql, env.MAX_ROWS);
  if (!guard.ok) return { ok: false, message: `安全检查未通过：${guard.detail ?? guard.reason}` };

  // 只读重跑：确认改后的 SQL 真能执行（错误 SQL 不允许进 corrections）
  let rowCount = 0;
  try {
    const shop = new DatabaseSync(env.SHOP_DB_PATH, { readOnly: true });
    try {
      const rows = shop.prepare(guard.sql).all() as Array<Record<string, unknown>>;
      rowCount = rows.length;
    } finally {
      shop.close();
    }
  } catch (err) {
    return { ok: false, message: `重跑失败：${err instanceof Error ? err.message.slice(0, 120) : String(err)}` };
  }

  const db = openAppDb();
  try {
    const runRow = db.prepare("SELECT question FROM runs WHERE id = ?").get(runId) as { question: string } | undefined;
    if (!runRow) return { ok: false, message: "找不到原 run" };
    // 表清单：与四张已知表做词匹配（few-shot 检索主要按表重叠打分）
    const tables = ["customers", "products", "orders", "order_items"].filter((t) =>
      new RegExp(`\\b${t}\\b`, "i").test(sql),
    );
    const id = `corr_${crypto.randomUUID().slice(0, 8)}`;
    saveCorrection(db, {
      id,
      question: runRow.question,
      sql,
      tables,
      keywords: [],
      createdAt: new Date().toISOString(),
    });
    db.prepare("UPDATE corrections SET verified_by_user = 1 WHERE id = ?").run(id);
    return { ok: true, message: `已存为纠正样本 ${id}（重跑 ${rowCount} 行）` };
  } finally {
    db.close();
  }
}
