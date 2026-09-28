import Link from "next/link";

import { DatabaseSync } from "node:sqlite";

import { ChartPanel } from "@/components/chat/chart-panel";
import { ResultTable } from "@/components/chat/result-table";
import type { ChartSpec } from "@/lib/events";
import { createRun, finishRun, getReport, insertStep, openAppDb } from "@/lib/db/app";
import { getConfig } from "@/lib/env";
import { guardSql } from "@/lib/sql/guard";
import type { RunCell } from "@/lib/reduce-events";

/**
 * 报表重跑（5G）：直接执行固化的 SQL —— 全程不调模型。
 * 完成标准的兑现：本页产生的 run 里 llm_call 步骤数为 0、耗时毫秒级。
 * 每次访问记一条 run + execute step（trace 可查），verdict 固定 verified
 * （SQL 从未变过，结果永远一致 —— 这正是固化 vs 重新生成的本质差异）。
 */
/** 只读执行固化 SQL 并计时（渲染期不做时钟调用，计时收敛在此） */
function executeReport(sql: string): { columns: string[]; rows: RunCell[][]; elapsedMs: number; error: string | null } {
  const env = getConfig();
  const startedAt = Date.now();
  try {
    const shop = new DatabaseSync(env.SHOP_DB_PATH, { readOnly: true });
    try {
      const stmt = shop.prepare(sql);
      const objects = stmt.all() as Array<Record<string, unknown>>;
      const columns = stmt.columns().map((c) => c.name);
      const rows = objects.map((o) =>
        columns.map((c) => {
          const v = o[c] === undefined ? null : (o[c] ?? null);
          return (typeof v === "bigint" ? Number(v) : v) as RunCell;
        }),
      );
      return { columns, rows, elapsedMs: Date.now() - startedAt, error: null };
    } finally {
      shop.close();
    }
  } catch (err) {
    return { columns: [], rows: [], elapsedMs: Date.now() - startedAt, error: err instanceof Error ? err.message : String(err) };
  }
}

export default async function ReportRerunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const db = openAppDb();
  let report;
  try {
    report = getReport(db, id);
  } finally {
    db.close();
  }

  if (!report) {
    return (
      <main className="mx-auto min-h-dvh max-w-3xl px-4 py-8">
        <Link href="/reports" className="text-sm text-neutral-500 hover:underline">← 返回</Link>
        <p className="mt-6 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          找不到报表 {id}
        </p>
      </main>
    );
  }

  // LIMIT 上限与 C1 的截断检测同源（都取 env.MAX_ROWS），否则收紧到的行数
  // 和判定「是否被截断」用的阈值会对不上，静默截断就报不出来
  const guard = guardSql(report.sql, getConfig().MAX_ROWS);
  if (!guard.ok) {
    return (
      <main className="mx-auto min-h-dvh max-w-3xl px-4 py-8">
        <Link href="/reports" className="text-sm text-neutral-500 hover:underline">← 返回</Link>
        <p className="mt-6 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          该报表的 SQL 未通过安全检查（{guard.detail ?? guard.reason}）—— 请删除后重新固化。
        </p>
      </main>
    );
  }

  const env = getConfig();
  const { columns, rows, elapsedMs, error } = executeReport(guard.sql);

  // trace：一条 run + 一个 execute 步骤，llm_call 恒为 0
  const traceDb = openAppDb();
  try {
    const runId = `rep_${crypto.randomUUID().slice(0, 8)}`;
    const now = Date.now();
    createRun(traceDb, {
      id: runId,
      question: `报表重跑：${report.name}`,
      asOfDate: env.AS_OF_DATE ?? "",
      llmMode: "replay",
      createdAt: new Date().toISOString(),
    });
    insertStep(traceDb, {
      runId,
      seq: 1,
      kind: "execute",
      startedAt: now,
      endedAt: now + elapsedMs,
      status: error === null ? "ok" : "failed",
      attributes: { source: "report_rerun", reportId: report.id, rows: rows.length },
    });
    finishRun(traceDb, {
      id: runId,
      verdict: error === null ? "verified" : "unverified",
      verdictReasons: error === null ? [] : [error],
      finalStatus: error === null ? "ok" : "SQL_FAILED",
      attempts: 0,
      llmCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      elapsedMs,
    });
  } finally {
    traceDb.close();
  }

  const chart: ChartSpec | null = (() => {
    try {
      const parsed = report.chartSpec ? (JSON.parse(report.chartSpec) as ChartSpec) : null;
      return parsed && parsed.kind !== "none" ? parsed : null;
    } catch {
      return null;
    }
  })();

  return (
    <main className="mx-auto min-h-dvh max-w-3xl px-4 py-8">
      <div className="mb-6 flex items-center justify-between">
        <Link href="/reports" className="text-sm text-neutral-500 hover:underline">← 返回</Link>
        <span className="font-mono text-xs text-neutral-400">{report.id}</span>
      </div>
      <header className="mb-4">
        <h1 className="text-xl font-semibold tracking-tight">{report.name}</h1>
        <p className="mt-1 text-xs text-neutral-500">
          <span className="stamp text-xs">0 次模型调用</span>{" "}
          <span className="ml-1">直接执行固化 SQL · 本次 {elapsedMs} ms · 结果永远一致</span>
        </p>
      </header>

      {error !== null ? (
        <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">执行失败：{error}</p>
      ) : (
        <div className="space-y-4">
          <ResultTable table={{ columns, rows, rowCount: rows.length, truncated: false, elapsedMs }} />
          {chart && <ChartPanel spec={chart} table={{ columns, rows, rowCount: rows.length, truncated: false, elapsedMs }} />}
        </div>
      )}
    </main>
  );
}
