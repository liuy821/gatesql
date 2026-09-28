/**
 * guard.ts 的验收测试，共 37 例，分三类：
 *   · 30 条语料 = 20 条必须拦下（攻击/危险形态）+ 10 条必须放行（防误杀）
 *   · 2 条附加约定（LIMIT 收紧、拒绝时给人类可读 detail）
 *   · 5 条引擎层行为（只读连接 + authorizer，需要连 data/shop.db 真跑）
 *
 * 前 29 条语料来自 docs/07-security.md 的自测清单，最后 1 条是「字符串字面量误杀」
 * 反例 —— 把 SELECT 'drop table' 也拦下的 guard 说明你在用关键字匹配，那是最弱的方案。
 * 放行用例与拦截用例同等重要：只测前者可以用「什么都不放过」来通过。
 *
 * 本文件是 TDD 起点（2C 先写测试变红，2B 实现转绿），不是文档 —— 别把它当规范读。
 */

import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";

import { DEFAULT_MAX_ROWS, guardSql, openReadOnlyConnection } from "@/lib/sql/guard";

const SHOP_DB = "data/shop.db";

interface AttackCase {
  name: string;
  sql: string;
  /** "reject" 表示必须被拦下；"allow" 表示必须放行（false-positive 防护） */
  expect: "reject" | "allow";
}

/**
 * 攻击语料。前 29 条来自 docs/07-security.md 的自测清单，
 * 最后 1 条是「字符串字面量误杀」反例 —— 把 SELECT 'drop table' 也拦下的
 * guard 说明你在用关键字匹配，那是最弱的方案。
 */
const ATTACK_CASES: AttackCase[] = [
  // —— 多语句 / 注释拆词 / 大小写 / 全角 ——
  { name: "分号多语句", sql: "SELECT 1; DROP TABLE orders", expect: "reject" },
  { name: "注释拆词-分号", sql: "SELECT/**/1;/**/DROP/**/TABLE/**/orders", expect: "reject" },
  { name: "大小写混写", sql: "sElEcT 1; dRoP tAbLe orders", expect: "reject" },
  { name: "全角分号", sql: "SELECT 1；DELETE FROM orders", expect: "reject" },
  // —— CTE / 子查询藏写操作 ——
  { name: "CTE 藏写操作", sql: "WITH x AS (DELETE FROM orders RETURNING 1) SELECT * FROM x", expect: "reject" },
  { name: "子查询藏写操作-嵌套", sql: "SELECT (SELECT 1 FROM (DELETE FROM orders))", expect: "reject" },
  { name: "UNION 拼接读系统表", sql: "SELECT 1 UNION SELECT * FROM sqlite_master", expect: "reject" },
  // —— PRAGMA / ATTACH ——
  { name: "PRAGMA 改可写模式", sql: "PRAGMA writable_schema=1", expect: "reject" },
  { name: "PRAGMA 读配置", sql: "PRAGMA journal_mode", expect: "reject" },
  { name: "ATTACH 挂载外部库", sql: "ATTACH DATABASE '/tmp/evil.db' AS evil", expect: "reject" },
  // —— 系统表 / 注释表 ——
  { name: "直接读 sqlite_master", sql: "SELECT * FROM sqlite_master", expect: "reject" },
  { name: "读 _column_comments 表", sql: "SELECT * FROM _column_comments", expect: "reject" },
  // —— 写操作直白形态（即使语义无效也必须被结构拒绝）——
  { name: "DELETE 直白", sql: "DELETE FROM orders", expect: "reject" },
  { name: "UPDATE 直白", sql: "UPDATE orders SET status='已退款'", expect: "reject" },
  { name: "INSERT 直白", sql: "INSERT INTO orders VALUES (1,2,'2026-01-01','已完成','APP')", expect: "reject" },
  { name: "DROP 直白", sql: "DROP TABLE orders", expect: "reject" },
  // —— 非法但需拒绝的形态 ——
  { name: "非 SELECT 开头", sql: "EXPLAIN SELECT * FROM orders", expect: "reject" },
  { name: "VACUUM", sql: "VACUUM", expect: "reject" },
  { name: "复制表结构写库", sql: "CREATE TABLE x AS SELECT * FROM orders", expect: "reject" },
  { name: "ALTER 加列", sql: "ALTER TABLE orders ADD COLUMN xx TEXT", expect: "reject" },
  // —— 合法但危险的资源类（靠 LIMIT 收紧兜底，但结构上不含写操作）——
  { name: "无 LIMIT 全表拉取", sql: "SELECT * FROM order_items", expect: "allow" },
  { name: "超大 LIMIT", sql: "SELECT * FROM order_items LIMIT 999999", expect: "allow" },
  // —— 有争议但必须放行的形态（false-positive 防护）——
  { name: "字符串字面量含危险词", sql: "SELECT 'drop table' AS x", expect: "allow" },
  { name: "注释里的危险词", sql: "SELECT 1 /* drop table orders */", expect: "allow" },
  { name: "字符串含分号", sql: "SELECT 'a;b' AS x", expect: "allow" },
  { name: "CTE 纯读", sql: "WITH x AS (SELECT id FROM orders WHERE status='已完成') SELECT COUNT(*) FROM x", expect: "allow" },
  { name: "窗口函数", sql: "SELECT id, RANK() OVER (ORDER BY amount DESC) FROM order_items", expect: "allow" },
  { name: "子查询比较", sql: "SELECT name FROM products WHERE price > (SELECT AVG(price) FROM products)", expect: "allow" },
  { name: "合法 JOIN+WHERE 过滤", sql: "SELECT o.channel, COUNT(DISTINCT o.id) FROM orders o JOIN order_items oi ON oi.order_id=o.id WHERE o.status='已完成' GROUP BY o.channel", expect: "allow" },
  { name: "COALESCE 处理可空列", sql: "SELECT COALESCE(region,'未知') FROM customers GROUP BY region", expect: "allow" },
];

describe("guardSql：20 条必须拦下 + 10 条必须放行", () => {
  for (const c of ATTACK_CASES) {
    it(`${c.expect === "reject" ? "拦下" : "放行"} — ${c.name}`, () => {
      const verdict = guardSql(c.sql);
      if (c.expect === "allow") {
        expect(verdict.ok, `本应放行却被拦下：${c.sql}`).toBe(true);
      } else {
        expect(verdict.ok, `本应拦下却放行了：${c.sql}`).toBe(false);
      }
    });
  }
});

describe("guardSql 的附加约定", () => {
  it("放行的 SQL 应带上被收紧的 LIMIT（无 LIMIT 时注入，超大时收紧）", () => {
    // 注意：这里不能用 `if (verdict.ok) { 断言 }` —— 那样一旦 guard 误拒，
    // 整个断言被跳过，测试反而静默变绿。必须先断言放行，再检查内容。
    const verdict = guardSql("SELECT * FROM orders");
    expect(verdict.ok, `应放行，实际被拒：${!verdict.ok && verdict.detail}`).toBe(true);
    if (!verdict.ok) return; // 不可达，仅为类型收窄
    const limitMatch = /LIMIT\s+(\d+)/i.exec(verdict.sql);
    expect(limitMatch).not.toBeNull();
    expect(Number(limitMatch![1])).toBeLessThanOrEqual(DEFAULT_MAX_ROWS);

    const big = guardSql("SELECT * FROM orders LIMIT 999999");
    expect(big.ok).toBe(true);
    if (!big.ok) return;
    expect(Number(/LIMIT\s+(\d+)/i.exec(big.sql)![1])).toBeLessThanOrEqual(DEFAULT_MAX_ROWS);
  });

  it("maxRows 由调用方决定（LIMIT 上限与 C1 截断检测同源）", () => {
    const tightened = guardSql("SELECT * FROM orders", 50);
    expect(tightened.ok).toBe(true);
    if (!tightened.ok) return;
    // 关键断言是「等于 50」而不是「≤1000」：证明调用方传的值真的生效了，
    // 而不是恰好命中了某个内部默认值
    expect(Number(/LIMIT\s+(\d+)/i.exec(tightened.sql)![1])).toBe(50);

    const shrunk = guardSql("SELECT * FROM orders LIMIT 80", 50);
    expect(shrunk.ok).toBe(true);
    if (!shrunk.ok) return;
    expect(Number(/LIMIT\s+(\d+)/i.exec(shrunk.sql)![1])).toBe(50);
  });

  it("拒绝时应给出 detail（人类可读）", () => {
    const v = guardSql("SELECT 1; DROP TABLE orders");
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.detail, "拒绝必须带可读理由：回喂与前端展示都依赖它").toBeTruthy();
  });
});

describe("openReadOnlyConnection：连接层 + authorizer", () => {
  function freshConnection() {
    const db = openReadOnlyConnection(SHOP_DB);
    expect(db).toBeInstanceOf(DatabaseSync);
    return db;
  }

  it("只读连接拒绝一切写语句", () => {
    const db = freshConnection();
    // authorizer 会先于 readOnly 拦下写语句，报错信息不一定是 readonly——
    // 契约是「任何写操作都抛异常」，两层任一生效即通过
    expect(() => db.exec("DELETE FROM orders")).toThrow();
  });

  it("authorizer 按动作码拒写；表名过滤刻意留给语句层（取舍，不是能力限制）", () => {
    const db = freshConnection();
    // 引擎层只看动作码，不看表名 —— 这是刻意分工：node:sqlite 的 READ 回调
    // 实际会给出表名（9/22 实测：arg3=表名、arg4=列名），所以引擎层「能」做
    // 表名过滤；把 _column_comments 这类应用约定放进引擎回调会让第 2 层
    // 携带第 4 层的语义，故留给 guardSql 的 ⑤（详见 docs/07 第 2 层与 guard.ts 注释）。
    // 此处只验证引擎层负责的事：任何写动作在 prepare 阶段即被拒，不依赖表名。
    expect(() => db.prepare("INSERT INTO orders VALUES (1,2,'2026-01-01','已完成','APP')")).toThrow();
    expect(() => db.prepare("UPDATE orders SET status='已退款'")).toThrow();
  });

  it("authorizer 必须放行正常 SELECT（防「全部拒绝」这种假安全）", () => {
    const db = freshConnection();
    // 只放行读类动作的白名单若写反（DENY 当成 OK），这条立刻红
    expect(db.prepare("SELECT COUNT(*) AS n FROM orders").get()).toEqual({ n: 12000 });
  });

  it("authorizer 拒绝 CTE 里暗藏的写操作", () => {
    const db = freshConnection();
    expect(() =>
      db.prepare("WITH x AS (DELETE FROM orders RETURNING 1) SELECT * FROM x"),
    ).toThrow();
  });

  it("authorizer 拒绝 PRAGMA / ATTACH 类动作", () => {
    const db = freshConnection();
    expect(() => db.prepare("PRAGMA journal_mode")).toThrow();
    expect(() => db.prepare("ATTACH DATABASE 'x' AS evil")).toThrow();
  });
});