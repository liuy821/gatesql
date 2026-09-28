/**
 * 哨兵测试：agent 代码路径上绝不出现数据库的 exec()（CLAUDE.md 三条底线之一）。
 *
 * 为什么禁 exec：实测 node:sqlite 的 prepare() 对多语句**静默只执行第一句且不报错**，
 * 所以「SELECT 1; DROP TABLE x」在 prepare 路径上不构成威胁 ——
 * 真正的多语句入口是 exec()。guard 的 AST 层挡住多语句之后，还必须保证
 * **没有任何代码路径能绕过 guard 把多语句递给引擎**。
 *
 * 判据为什么是「默认全禁 + 正则接收者白名单」而不是「找 db.exec」：
 *   按变量名匹配会漏掉 conn.exec() / client.exec() / store.exec() ——
 *   写代码的人换一个变量名就静默绕过，这种哨兵等于没有。
 *   反过来默认全禁会误伤 RegExp.prototype.exec（那是合法 JS，与数据库无关，
 *   src 里实测有两处），所以只给正则形状的接收者开一条窄口子。
 *
 * 本文件自身的可信度（哨兵也得被测）：
 *   1. 探测器有独立单测，含「换个变量名也要抓到」与「RegExp.exec 不误报」两组
 *   2. 目录遍历有「找到文件数」下限断言 —— 路径写错导致扫了个空目录，
 *      会让"零命中"断言静默变绿，这是哨兵测试最经典的失效方式
 *   3. 反向对照：已知合法的 src/lib/db/app.ts 必须被探测器**抓到**，
 *      证明探测器真在读文件内容
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/** 任意 `<标识符>.exec(` 调用；正则字面量（/x/.exec）没有标识符接收者，天然不匹配 */
const ANY_IDENT_EXEC = /([A-Za-z_$][\w$]*)\s*\.\s*exec\s*\(/g;

/**
 * 先剥掉注释再扫。不剥的话，一句「这里为什么不用 db.exec()」的注释会把哨兵变红 ——
 * 而哨兵一旦会因为读代码写注释而红，人们很快就要学会把它改成 it.skip。
 * 代价：含 `//` 的字符串字面量（如 URL）会被连带剥掉行尾，但那些内容里没有 .exec(，
 * 对本判据无影响。
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** 正则形状的接收者：按 . / _ / 驼峰切段后，任一段是 re|regex|regexp|pattern|matcher */
const REGEX_SEGMENT = /^(?:re|regex|regexp|pattern|matcher)$/i;
function isRegexReceiver(name: string): boolean {
  return name.split(/[._]|(?=[A-Z])/).some((seg) => REGEX_SEGMENT.test(seg));
}
// 注意是「切段」而不是「结尾匹配」：store / core / azure 都以 "re" 结尾，
// 若按结尾判断，store.exec() 会被当成正则静默放行 —— 那是哨兵最坏的失效方式。

/** 返回源码里所有「疑似数据库 exec」的调用片段 */
export function findDbExec(source: string): string[] {
  return [...stripComments(source).matchAll(ANY_IDENT_EXEC)]
    .filter((m) => !isRegexReceiver(m[1]))
    .map((m) => `${m[1]}.exec(`);
}

/** 递归收集目录下所有 .ts/.tsx 文件 */
function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...collectTsFiles(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** 被认定为「agent 代码路径」的目录 */
const AGENT_PATHS = ["src/lib/agent", "src/lib/sql", "src/app/api"];

describe("findDbExec 探测器（哨兵自己要先可靠）", () => {
  it("抓到最常见的 db.exec / appDb.exec", () => {
    expect(findDbExec('db.exec("DELETE FROM orders")')).toEqual(["db.exec("]);
    expect(findDbExec("  appDb.exec(SCHEMA_SQL);")).toEqual(["appDb.exec("]);
  });

  it("换个变量名也照样抓到（不按名字放行）", () => {
    expect(findDbExec('conn.exec("SELECT 1; DROP TABLE x")')).toEqual(["conn.exec("]);
    expect(findDbExec("await store.exec(sql)")).toEqual(["store.exec("]);
    expect(findDbExec("sqliteClient.exec(ddl)")).toEqual(["sqliteClient.exec("]);
  });

  it("不误报 RegExp.exec —— 合法 JS，与数据库无关", () => {
    expect(findDbExec("rule.regex.exec(question)")).toEqual([]);
    expect(findDbExec("const m = /x/.exec(s);")).toEqual([]);
    expect(findDbExec('  const scan = /^SCAN\\s+(\\S+)/.exec(detail);')).toEqual([]);
    expect(findDbExec("myRe.exec(q)")).toEqual([]);
  });

  it("不误报 .execute(（executor 的正常方法名）", () => {
    expect(findDbExec("await executor.execute(guard.sql)")).toEqual([]);
    expect(findDbExec("return db.handle.executeQuery()")).toEqual([]);
  });

  it("注释里提到 exec 不算违规（否则写文档就会让哨兵变红）", () => {
    expect(findDbExec("// 这里为什么不用 db.exec() —— 见 CLAUDE.md")).toEqual([]);
    expect(findDbExec("/* 历史坑：prepare 不拦多语句，禁用 conn.exec */")).toEqual([]);
    expect(findDbExec('const v = db.execute(sql); // 不用 exec')).toEqual([]);
  });

  it("注释之后仍然真调用的，照样抓到", () => {
    expect(findDbExec("// 说明\n  db.exec(SCHEMA_SQL);")).toEqual(["db.exec("]);
  });
});

describe("agent 代码路径零 db.exec()（CLAUDE.md 底线）", () => {
  const dirs = AGENT_PATHS.map((p) => path.resolve(process.cwd(), p));

  it("待扫目录都存在，且文件数量达到下限（防路径写错导致静默通过）", () => {
    for (const d of dirs) expect(statSync(d).isDirectory(), d).toBe(true);
    const count = dirs.reduce((n, d) => n + collectTsFiles(d).length, 0);
    expect(count).toBeGreaterThanOrEqual(15);
  });

  it("src/lib/agent、src/lib/sql、src/app/api 下不出现数据库 exec()", () => {
    const offenders: string[] = [];
    for (const dir of dirs) {
      for (const file of collectTsFiles(dir)) {
        const hits = findDbExec(readFileSync(file, "utf-8"));
        if (hits.length > 0) {
          offenders.push(`${path.relative(process.cwd(), file)} → ${hits.join(", ")}`);
        }
      }
    }
    expect(
      offenders,
      `agent 路径出现 exec()，可绕过 guard 的多语句防线：\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("反向对照：应用层建表的 db.exec 必须被抓到（证明探测器真在读文件）", () => {
    const appLayer = readFileSync(path.resolve(process.cwd(), "src/lib/db/app.ts"), "utf-8");
    expect(findDbExec(appLayer)).toContain("db.exec(");
  });
});
