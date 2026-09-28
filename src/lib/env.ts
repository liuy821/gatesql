/**
 * 运行环境配置：全部从 process.env 读取，用 Zod 校验。
 * 允许缺失/默认值的字段显式标注；密钥缺失时自动走 replay 模式（见 llm.ts）。
 */

import { z } from "zod";

import { DEFAULT_MAX_ROWS } from "@/lib/sql/guard";

const EnvSchema = z.object({
  LLM_BASE_URL: z.string().url().default("https://ark.cn-beijing.volces.com/api/coding/v3"),
  LLM_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().default("ark-code-latest"),
  /** live 真实调用 / record 录制 / replay 回放（无 key 或缺 key 时默认 replay） */
  LLM_MODE: z.enum(["live", "record", "replay"]).optional(),
  /** 线上协议：auto（按 baseURL 推断）/ responses / chat_completions */
  LLM_WIRE: z.enum(["auto", "responses", "chat_completions"]).default("auto"),
  SHOP_DB_PATH: z.string().default("data/shop.db"),
  APP_DB_PATH: z.string().default("data/app.db"),
  /** 覆盖默认时钟（默认 = shop.db 的 max(orders.created_at)） */
  AS_OF_DATE: z.string().date().optional(),
  /** 单条查询超时 */
  QUERY_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  /** 行数上限。默认值 import 自 guard 的 DEFAULT_MAX_ROWS —— 一处真相，
   *  否则改了这里而 guard 仍按旧值收紧 LIMIT，C1 的截断检测会静默失效 */
  MAX_ROWS: z.coerce.number().int().positive().default(DEFAULT_MAX_ROWS),
  /** 上下文工程 A/B 开关（docs/08 第 4 周）：off 时 schema 卡片不注入低基数列枚举值 */
  ENUM_INJECTION: z.enum(["on", "off"]).default("on"),
  /** 上下文工程 A/B 开关（docs/08 第 4 周）：off 时生成提示词不注入 R1-R8 口径规则文本 */
  RULES_INJECTION: z.enum(["on", "off"]).default("on"),
  /** 生成后自检 A/B 开关（docs/08 第 4 周）：默认 off —— 实验证明前保持关闭，不影响既有 cassette */
  SELF_CHECK: z.enum(["on", "off"]).default("off"),
  /** few-shot A/B 开关（docs/08 第 4 周 / docs/05 第四节）：默认 off；样本来自 corrections verified 行 */
  FEW_SHOT: z.enum(["on", "off"]).default("off"),
  /** 每日模型花费预算（元）；耗尽后 live/record 降级到 replay（docs/08 6F），-1 为不限 */
  DAILY_BUDGET_CNY: z.coerce.number().default(20),
});

export type EnvConfig = z.infer<typeof EnvSchema>;

/**
 * 每次现取（不做模块级缓存）：Zod 解析成本可忽略，而缓存会让测试、
 * 评测脚本里改 process.env 后拿到的还是旧配置（实测踩过：eval.ts 先设
 * LLM_MODE 再调 getConfig，因缓存顺序错了也不报错，假象难查）。
 */
export function getConfig(): EnvConfig {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`环境变量配置不合法: ${JSON.stringify(parsed.error.flatten().fieldErrors)}`);
  }
  return parsed.data;
}