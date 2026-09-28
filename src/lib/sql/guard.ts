/**
 * SQL 安全检查（作者本人重写本文件 —— 面试必问，见自检清单）。
 *
 * 实现分层（docs/07-security.md 的**安全层号**，与 docs/05 的流程步骤号 A1~C4 是两套坐标系）：
 *   openReadOnlyConnection —— 第 1 层连接只读 + 第 2 层引擎级授权回调
 *   guardSql                —— 第 4 层语句层 AST 白名单（fail-closed）
 *
 * guardSql 内部用 ①~⑦ 标记它自己的检查次序（既不是流程步骤，也不是安全层）：
 *   ① 正则预检 ② 解析并判多语句 ③ 语句类型白名单 ④ 递归扫危险节点
 *   ⑤ 表名过滤 ⑥ LIMIT 注入/收紧 ⑦ sqlify 重建
 *
 * 本实现基于实测的 node-sql-parser v5 行为（见 scripts/_tmp_probe_ast*.cjs）：
 *   - 单条 SELECT 返回 { type:'select', ... }，多条语句返回数组
 *   - limit.value 在 v5 是「数组」[{ type:'number', value:N }]
 *   - CTE 藏写操作 / PRAGMA / ATTACH 在 v5 直接解析失败 —— 被 AST_PARSE_FAILED 兜住
 *   - EXPLAIN 能解析成功，type='explain' —— 需要按 type 白名单拦
 *   - 指定 databaseType:'sqlite'；sqlify 重建会给标识符加反引号（SQLite 合法）
 *
 * ⚠️ 注释可信度声明：本文件 9/22 之前关于「authorizer 拿不到表名」的说法是**错的**
 * （形参名按直觉猜的，与 SQLite C API 实际位置不符，导致误判能力边界），
 * 已用探针推翻并改正 —— 见下方第 1+2 层的实测记录。
 * 教训：**参数名说谎比没有注释更糟**，它会让一个错误的结论看起来像实证。
 */

import { DatabaseSync } from "node:sqlite";
import { Parser, type AST, type Option } from "node-sql-parser";

function astifyWithSqliteDialect(parser: Parser, sql: string): unknown {
  // 实测：运行时只认 databaseType 键（window 函数在 database:'sqlite' 下
  // 会解析失败，且默认方言会破坏部分语法）；而 5.4.0 的类型声明误写成了
  // database —— 上游类型 bug，用断言绕开，运行时键保持正确。
  return parser.astify(sql, { databaseType: "sqlite" } as unknown as Option);
}

/* ------------------------------------------------------------------ */
/* 对外类型（消费方：executor.ts / loop.ts / route.ts，勿改签名）       */
/* ------------------------------------------------------------------ */

export type GuardReason =
  | "PATTERN_SEMICOLON"
  | "NOT_SELECT_OR_WITH"
  | "AST_PARSE_FAILED"
  | "DANGEROUS_NODE";
// 注：原有一个 AUTHORIZER_REJECTED 值，但没有任何代码路径会返回它
// （引擎层拒绝写操作是以抛错形式出现，走 B6 的 SQL_FAILED），已删除。
// 保留永不发生的枚举值，会让后来读代码的人去找一条不存在的路径。

export type GuardVerdict =
  | { ok: true; sql: string }
  | { ok: false; reason: GuardReason; detail?: string };

/* ------------------------------------------------------------------ */
/* 第 1 + 2 层：只读连接 + 引擎级授权回调                              */
/* ------------------------------------------------------------------ */

/**
 * SQLite authorizer 返回值语义（C API）：
 *   SQLITE_OK   = 0  —— 放行当前动作
 *   SQLITE_DENY = 1  —— 拒绝，整个语句报错中止
 * 注意与广大博客常见误述相反：0 才是允许。测试不校验返回值，只校验行为，
 * 写错这个会导致「全部放行」或「全部拒绝」，从测试红字可立刻看出。
 *
 * 实测（9/22 重做，Node v24.20 + node:sqlite，逐条对照回调实参）：
 *   C 签名是 (action, arg3, arg4, arg5, arg6)，各动作码下含义不同 ——
 *   SQLITE_READ(20)：arg3 = 表名，arg4 = 列名，arg5 = 库名。真实序列示例：
 *     SELECT o.channel, SUM(oi.amount) FROM orders o JOIN order_items oi …
 *       → action=21 (SELECT)  arg3=null
 *       → action=20 (READ)    arg3="orders"       arg4="channel"  arg5="main"
 *       → action=31 (FUNCTION) arg4="sum"
 *       → action=20 (READ)    arg3="order_items"  arg4="amount"   arg5="main" …
 *   写/结构类动作码同样上报：DELETE=9、PRAGMA=19、DROP_TABLE=3、ATTACH=22。
 *
 * ⚠️ 本文件与 docs/07 此处原写着「READ 不上报表名、引擎层无法按表名过滤内部表」，
 *    **是错的**：错因是形参被命名为 (action, _catalog, _table, _column, _arg)，
 *    与 C API 的实际位置不符（arg3 才是表名），于是把「column 位置上有值」
 *    误读成「只有列名没有表名」；下划线前缀使 TS 不报未使用，错误结论得以固化。
 *    实测证明：在 authorizer 里判 arg3.startsWith("sqlite_") 并 DENY，
 *    `SELECT name FROM sqlite_master` 会在 prepare 阶段被拒
 *    （报 "access to sqlite_master.name is prohibited"）—— 引擎层做得到。
 *
 * 那为什么表名过滤仍然放在语句层 guardSql 的 ⑤？**这是取舍不是能力限制**：
 *   1. 引擎层应保持「不懂业务知识」—— 它只按动作码判断；
 *      _column_comments 这类应用约定写进 authorizer 会让第 2 层开始携带第 4 层的语义
 *   2. AST 层能覆盖子查询内的引用（递归收集表名），表达力更完整
 *   3. 两处都挡是好事：⑤ 是提交前第一道，authorizer 是编译期最后一道
 */

const SQLITE_OK = 0;
const SQLITE_DENY = 1;

/** authorizer 动作码中最常用的几个（完整清单见 sqlite3.h） */
const ACTION_READ = 20;
const ACTION_SELECT = 21;
const ACTION_FUNCTION = 31;

/** 语句层内部表过滤用（见下）：schema 元数据由应用层喂给模型，不允许自查 */
const INTERNAL_TABLE_PREFIX = "sqlite_"; // sqlite_master / sqlite_sequence / ...
const BLOCKED_TABLES = ["_column_comments"];

function isBlockedTable(name: string): boolean {
  return name.startsWith(INTERNAL_TABLE_PREFIX) || BLOCKED_TABLES.includes(name);
}

/**
 * 收集 AST 里所有「表引用」。实测 v5 的 FROM/JOIN 表引用是
 * { db, table } 裸对象（没有 type 字段），而列引用 column_ref 是
 * { table, column } —— 用「有 table、无 column」来区分二者。
 * 返回去重后的表名集合。
 */
function collectTableNames(root: unknown): Set<string> {
  const names = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node !== null && typeof node === "object") {
      const rec = node as Record<string, unknown>;
      if (typeof rec.table === "string" && rec.column === undefined) {
        names.add(rec.table);
      }
      for (const value of Object.values(rec)) walk(value);
    }
  };
  walk(root);
  return names;
}

/**
 * 第 1 层 + 第 2 层。
 * 以只读模式打开被分析库，并装上授权回调。
 * 连接层 readOnly 是引擎级兜底；authorizer 是编译期闸门，二者互补。
 */
export function openReadOnlyConnection(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath, { readOnly: true });

  // 形参按 C API 的位置命名（SQLITE_READ 下依次是 表名/列名/库名/触发器名）。
  // 下划线前缀 = 本层刻意不看它们：引擎层只按动作码判断，业务知识留在第 4 层。
  // （原命名 (action, _catalog, _table, _column, _arg) 是错的 —— 见上方实测记录）
  db.setAuthorizer((action, _arg3, _arg4, _arg5, _arg6) => {
    if (action !== ACTION_READ && action !== ACTION_SELECT && action !== ACTION_FUNCTION) {
      return SQLITE_DENY;
    }
    return SQLITE_OK;
  });

  return db;
}

/* ------------------------------------------------------------------ */
/* 第 4 层：语句层 AST 白名单（fail-closed）                           */
/* ------------------------------------------------------------------ */

/** 在 AST 中视为危险的节点类型（含子查询/CTE 里嵌套的那些） */
const DANGEROUS_NODE_TYPES = new Set([
  "insert",
  "update",
  "delete",
  "drop",
  "truncate",
  "replace",
  "alter",
  "create",
  "rename",
  "attach",
  "detach",
  "pragma",
  "vacuum",
  "explain",
  "show",
  "set",
  "call",
  "load",
  "begin",
  "commit",
  "rollback",
]);

/**
 * 全树递归扫描。node-sql-parser 的 AST 就是普通对象/数组；
 * 遇到带 type 字段且落在危险集合里的节点即命中。
 */
function findDangerousNode(node: unknown): string | null {
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findDangerousNode(item);
      if (hit) return hit;
    }
    return null;
  }
  if (node !== null && typeof node === "object") {
    const rec = node as Record<string, unknown>;
    if (typeof rec.type === "string" && DANGEROUS_NODE_TYPES.has(rec.type)) {
      return rec.type;
    }
    for (const value of Object.values(rec)) {
      const hit = findDangerousNode(value);
      if (hit) return hit;
    }
  }
  return null;
}

/** 把 limit 规整成 v5 的 { seperator, value: [...] } 形态 */
function buildLimit(numberValue: number) {
  return { seperator: "", value: [{ type: "number", value: numberValue }] };
}

/**
 * 单次查询的行数上限默认值。**这里是唯一的真相源** ——
 * env.ts 的 MAX_ROWS 默认值 import 它，不再各写一个 1000。
 * （此前两处各有一个 1000，靠注释维系一致；一旦有人只调 env，
 *   guard 仍按 1000 收紧，而 C1 的「行数正好等于 LIMIT」截断检测按新值判，
 *   静默截断就再也报不出来了。）
 */
export const DEFAULT_MAX_ROWS = 1000;

/**
 * 第 4 层：语句级防护（fail-closed）。解析失败一律拒绝。
 *
 * 纯函数：不连数据库、不读配置、不产生副作用 —— 这是它能被 30 条语料完全覆盖测试的原因。
 * 需要外部信息才能判断的事都不属于它（口径→lint、代价→EQP、结果→体检）。
 *
 * @param maxRows 行数上限，由调用方传（loop 传 env.MAX_ROWS）；缺省用 DEFAULT_MAX_ROWS
 * @returns ok 时 sql 为**已注入/收紧 LIMIT 后从 AST 重建**的语句 ——
 *          下游（lint/列名核对/EQP/执行）必须用这个返回值，而不是模型原串，
 *          以保证「检查过的东西」和「执行的东西」是同一个。
 */
export function guardSql(rawSql: string, maxRows: number = DEFAULT_MAX_ROWS): GuardVerdict {
  // —— ① 正则预检（廉价前置过滤）——
  // 去掉首部注释与空白后，只接受 SELECT / WITH 开头
  const stripped = rawSql.replace(/^\s*(--[^\n]*\n|\/\*[\s\S]*?\*\/|\s)+/, "");
  if (!/^(select|with)\b/i.test(stripped)) {
    return { ok: false, reason: "NOT_SELECT_OR_WITH", detail: "只支持以 SELECT 或 WITH 开头的查询语句" };
  }

  // —— ② 解析并判定多语句 ——
  let parsed: unknown;
  try {
    parsed = astifyWithSqliteDialect(new Parser(), stripped);
  } catch {
    // 解析失败即拒绝。实测 v5 对 CTE 藏写操作 / PRAGMA / ATTACH 都会解析失败，
    // 这条路径天然兜住了它们。
    return { ok: false, reason: "AST_PARSE_FAILED", detail: "SQL 无法解析，已按不信任处理" };
  }

  if (Array.isArray(parsed)) {
    return { ok: false, reason: "PATTERN_SEMICOLON", detail: "检测到多条语句，一次只允许一条查询" };
  }

  const ast = parsed as Record<string, unknown>;

  // —— ③ 语句类型白名单 ——
  if (ast.type !== "select") {
    return {
      ok: false,
      reason: "DANGEROUS_NODE",
      detail: `检测到不允许的语句类型: ${String(ast.type)}`,
    };
  }

  // —— ④ 递归扫危险节点（含 with/子查询里的嵌套）——
  const hit = findDangerousNode(ast);
  if (hit) {
    return { ok: false, reason: "DANGEROUS_NODE", detail: `检测到危险语句片段: ${hit}` };
  }

  // —— ⑤ 表名过滤（系统表 / 注释表）——
  const blockedTables = [...collectTableNames(ast)].filter(isBlockedTable);
  if (blockedTables.length > 0) {
    return {
      ok: false,
      reason: "DANGEROUS_NODE",
      detail: `检测到不允许访问的表: ${blockedTables.join(", ")}`,
    };
  }

  // —— ⑥ LIMIT 注入 / 收紧（防结果集打爆内存和 SSE）——
  const limit = ast.limit as { value?: unknown } | null | undefined;
  const currentValue = Array.isArray(limit?.value) ? (limit.value[0] as { type?: string; value?: unknown } | undefined) : undefined;

  if (!limit) {
    ast.limit = buildLimit(maxRows);
  } else if (currentValue?.type === "number" && typeof currentValue.value === "number" && currentValue.value > maxRows) {
    ast.limit = buildLimit(maxRows);
  } else if (currentValue?.type !== "number") {
    // LIMIT 非数字常量（如 LIMIT 5 OFFSET 2 的组合、参数化、ALL）——
    // 统一收紧为默认上限，保证不会带着无限/大计数执行
    ast.limit = buildLimit(maxRows);
  }

  // —— ⑦ 重建 SQL 文本 ——
  try {
    const finalSql = new Parser().sqlify(ast as unknown as AST);
    return { ok: true, sql: finalSql };
  } catch {
    return { ok: false, reason: "AST_PARSE_FAILED", detail: "改写后的 SQL 重建失败，已按不信任处理" };
  }
}