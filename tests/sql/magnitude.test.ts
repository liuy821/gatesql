import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";

import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { checkMagnitude } from "@/lib/sql/magnitude";

const dbFiles: string[] = [];

afterEach(() => {
  dbFiles.splice(0).forEach((f) => rmSync(f, { force: true }));
});

/**
 * 最小 shop.db：
 *   o1 已完成 2026-08-05 → 明细 10 元
 *   o2 已完成 2026-07-01 → 明细 2000 元
 *   o3 已取消 2026-08-10 → 明细 5000 元
 * 库内明细总额 7010；2026-08 明细总额（不分状态）5010
 */
function makeShopDb(): string {
  const dir = path.join("data", "test-app");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `magnitude_test_${crypto.randomUUID()}.db`);
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE orders (id INTEGER PRIMARY KEY, status TEXT, created_at TEXT);
    CREATE TABLE order_items (id INTEGER PRIMARY KEY, order_id INTEGER, amount REAL);
    INSERT INTO orders VALUES (1, '已完成', '2026-08-05'), (2, '已完成', '2026-07-01'), (3, '已取消', '2026-08-10');
    INSERT INTO order_items VALUES (1, 1, 10), (2, 2, 2000), (3, 3, 5000);
  `);
  db.close();
  dbFiles.push(file);
  return file;
}

const BASE = "SELECT SUM(oi.amount) AS total FROM order_items oi JOIN orders o ON o.id = oi.order_id";

describe("checkMagnitude（8d：金额结果 vs 去业务过滤、留时间范围的控制总数）", () => {
  it("全时段已完成销售额 → 占比正常 → ok", () => {
    const r = checkMagnitude({
      sql: `${BASE} WHERE o.status = '已完成'`,
      columns: ["total"],
      rows: [[2010]],
      shopDbPath: makeShopDb(),
    });
    // 控制查询剥掉 status、保留时间（无）→ 全库 7010；2010/7010 ≈ 0.287
    expect(r.status).toBe("ok");
    if (r.status === "ok") expect(r.ratio).toBeCloseTo(2010 / 7010, 5);
  });

  it("9/28 修订：占比 <1% 不再 fail（单实体问题天然占比极小，结构性误报已移除）", () => {
    const r = checkMagnitude({
      sql: `${BASE} WHERE o.status = '已完成' AND o.created_at >= '2026-08-01' AND o.created_at <= '2026-08-31'`,
      columns: ["total"],
      rows: [[10]],
      shopDbPath: makeShopDb(),
    });
    // 控制查询保留 8 月时间条件、剥掉 status → 5010；10/5010 ≈ 0.2%，旧版 fail，现应 ok
    expect(r.status).toBe("ok");
    if (r.status === "ok") expect(r.ratio).toBeLessThan(0.01);
  });

  it("控制查询保留时间范围的证据：8 月口径下 6000 超过 8 月控制总数 5010 → fail", () => {
    const r = checkMagnitude({
      sql: `${BASE} WHERE o.status = '已完成' AND o.created_at >= '2026-08-01' AND o.created_at <= '2026-08-31'`,
      columns: ["total"],
      rows: [[6000]],
      shopDbPath: makeShopDb(),
    });
    // 若控制查询错误地剥掉时间（=7010），6000 < 7010 会 ok；
    // 正确保留时间（=5010）时 6000 > 5010 → fail。以此锁定「保留时间」不被回归
    expect(r.status).toBe("fail");
    if (r.status === "fail") expect(r.ratio).toBeGreaterThan(1);
  });

  it("空集（NULL 结果）→ 不表态，交给空集体检", () => {
    const r = checkMagnitude({
      sql: `${BASE} WHERE o.status = '已完成' AND o.created_at >= '2027-01-01' AND o.created_at <= '2027-01-31'`,
      columns: ["total"],
      rows: [[null]],
      shopDbPath: makeShopDb(),
    });
    expect(r.status).toBe("skip");
  });

  it("AVG / GROUP BY / COUNT 等非单一 SUM 形态 → 全部 skip 不表态", () => {
    const dbPath = makeShopDb();
    const cases = [
      `SELECT AVG(oi.amount) AS v FROM order_items oi WHERE oi.amount > 0`,
      `SELECT o.status, SUM(oi.amount) AS total FROM order_items oi JOIN orders o ON o.id = oi.order_id GROUP BY o.status`,
      `SELECT COUNT(*) AS n FROM order_items`,
    ];
    for (const sql of cases) {
      const r = checkMagnitude({ sql, columns: [], rows: [[1]], shopDbPath: dbPath });
      expect(r.status, sql).toBe("skip");
    }
  });

  it("占比 >100%（结果超过控制总数）→ fail", () => {
    const r = checkMagnitude({
      sql: `${BASE} WHERE o.status = '已完成'`,
      columns: ["total"],
      rows: [[99999]],
      shopDbPath: makeShopDb(),
    });
    expect(r.status).toBe("fail");
    if (r.status === "fail") expect(r.ratio).toBeGreaterThan(1);
  });

  it("无数据库连接 → skip", () => {
    const r = checkMagnitude({
      sql: `${BASE} WHERE o.status = '已完成'`,
      columns: ["total"],
      rows: [[2010]],
      shopDbPath: null,
    });
    expect(r.status).toBe("skip");
  });
});
