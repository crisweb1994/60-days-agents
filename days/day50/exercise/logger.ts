// 第 48 天：结构化日志。容器里的程序只管往标准输出写，一行一条 JSON；收集、存储、检索交给平台（Docker 的日志驱动、Loki、云厂商的日志服务）。
// 每一条带上时间、级别、消息和字段；字段里的密钥打码，用户的敏感信息脱敏（第 39 天），这样日志可以放心地交给运维和第三方服务。
import { maskPII } from './guardrails.ts';

export type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** 字段名里带这些词的，值整个换成 [已隐藏] */
const SECRET_FIELDS = /authorization|cookie|password|secret|token|api[-_]?key/i;

/**
 * 清理字段：
 * - 名字像密钥的：[已隐藏]
 * - 字符串：敏感信息打码（maskPII）
 * - Error：只留 name 和 message（message 同样打码），不留整个对象
 * - 对象和数组：递归处理，最多 5 层，再深的写成 [太深了]
 */
export function redactFields(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return maskPII(value).text;
  if (value instanceof Error) return { name: value.name, message: maskPII(value.message).text };
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 5) return '[太深了]';
  if (Array.isArray(value)) return value.map((v) => redactFields(v, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SECRET_FIELDS.test(k) ? '[已隐藏]' : redactFields(v, depth + 1)]));
}

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  /** 带上固定字段（比如 requestId、role）的子日志 */
  child(fields: Record<string, unknown>): Logger;
}

/** 低于 level 的不写；每条是一行 JSON：{ time, level, msg, ...固定字段, ...这次的字段 }，字段都经过 redactFields */
export function createLogger({ level = 'info', write = (line: string) => process.stdout.write(`${line}\n`), base = {}, now = () => new Date() }: { level?: Level; write?: (line: string) => void; base?: Record<string, unknown>; now?: () => Date } = {}): Logger {
  const log = (lvl: Level) => (message: string, fields: Record<string, unknown> = {}) => {
    if (ORDER[lvl] < ORDER[level]) return;
    write(JSON.stringify({ time: now().toISOString(), level: lvl, msg: message, ...(redactFields({ ...base, ...fields }) as Record<string, unknown>) }));
  };
  return {
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
    child: (fields) => createLogger({ level, write, now, base: { ...base, ...fields } }),
  };
}
