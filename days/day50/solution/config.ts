// 第 48 天：部署时的配置。所有配置都从环境变量读（十二要素应用的做法），启动时一次校验完：
//   缺了、格式不对，把**所有**问题一起列出来再退出，而不是跑到一半才发现少了一个
//   密钥只在这里读一次，打印配置时打码
// 开发时从 .env 读；生产上由部署平台注入（docker compose 的 env_file、Kubernetes 的 Secret、云平台的密钥管理）。
// 第 50 天：加上运营要用的配置：管理员、邀请码、灰度比例、告警、prompt 和反馈放在哪、每日配额、单价。
import { z } from 'zod';

const url = (name: string) => z.url({ message: `${name} 要是一个网址` });
const optionalUrl = (name: string) => z.preprocess((v) => (v === '' ? undefined : v), url(name).optional());
const optional = z.preprocess((v) => (v === '' ? undefined : v), z.string().optional());

export const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /** web：只跑接口；worker：只跑后台任务；all：都跑（单机部署） */
  ROLE: z.enum(['web', 'worker', 'all']).default('all'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  OPENAI_BASE_URL: url('OPENAI_BASE_URL'),
  OPENAI_API_KEY: z.string().min(1, 'OPENAI_API_KEY 不能是空的'),
  OPENAI_MODEL: z.string().min(1, 'OPENAI_MODEL 不能是空的'),
  EMBEDDING_MODEL: optional,
  VISION_MODEL: optional,
  DATABASE_URL: optionalUrl('DATABASE_URL'),
  REDIS_URL: optionalUrl('REDIS_URL'),
  /** 会话令牌的签名密钥（第 46 天），至少 32 个字符 */
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET 至少 32 个字符，用 openssl rand -base64 48 生成'),
  /** 上传的文件放在哪个目录（第 47 天）；线上换成对象存储 */
  OBJECT_DIR: z.string().default('/data/objects'),
  /** 优雅退出时最多等多久，毫秒 */
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(0).default(25_000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  /** 管理员的邮箱，逗号分隔（第 50 天）：能看 /api/admin/stats */
  ADMIN_EMAILS: z.string().default(''),
  /** 邀请码，逗号分隔。配了就只有拿到邀请码的人能注册（试用阶段） */
  INVITE_CODES: optional,
  /** canary 标签的 prompt 给多少用户，0–100（第 49 天的灰度） */
  CANARY_PERCENT: z.coerce.number().min(0).max(100).default(0),
  /** 告警发到哪个群机器人（第 49 天） */
  ALERT_WEBHOOK_URL: optionalUrl('ALERT_WEBHOOK_URL'),
  /** prompt 的注册表文件（第 49 天） */
  PROMPTS_FILE: z.string().default('/data/prompts.json'),
  /** 反馈和待审核用例放在哪个目录 */
  FEEDBACK_DIR: z.string().default('/data/feedback'),
  /** 每个用户每天最多几次、最多花多少钱（第 46 天） */
  DAILY_MAX_REQUESTS: z.coerce.number().int().min(1).default(30),
  DAILY_MAX_COST: z.coerce.number().min(0).default(1),
  /** 模型的单价，格式见第 2 天的 parsePrice。不配就只统计次数 */
  OPENAI_PRICE: optional,
});

export type AppConfig = z.infer<typeof ConfigSchema>;

/** 生产环境额外的要求：要有数据库和 Redis（内存版的队列、PGlite 重启就没了，也不能开多个进程） */
function productionProblems(config: AppConfig): string[] {
  if (config.NODE_ENV !== 'production') return [];
  const problems: string[] = [];
  if (!config.DATABASE_URL) problems.push('DATABASE_URL：生产环境必须配置数据库');
  if (!config.REDIS_URL) problems.push('REDIS_URL：生产环境必须配置 Redis');
  return problems;
}

/**
 * 读配置：用 ConfigSchema 校验 env，再检查生产环境的额外要求。
 * 成功返回 { ok: true, config }；失败返回 { ok: false, problems }，每条是「变量名：原因」，所有问题都列出来
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): { ok: true; config: AppConfig } | { ok: false; problems: string[] } {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) return { ok: false, problems: parsed.error.issues.map((i) => `${i.path.join('.')}：${i.message}`) };
  const problems = productionProblems(parsed.data);
  return problems.length ? { ok: false, problems } : { ok: true, config: parsed.data };
}

/** 名字里带这些词的配置是密钥 */
const SECRET_NAMES = /KEY|SECRET|TOKEN|PASSWORD/i;

/** 打印配置时打码：密钥只留前 4 位；网址里的密码换成 *** */
export function describeConfig(config: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(config).map(([key, value]) => {
      if (typeof value !== 'string') return [key, value];
      if (SECRET_NAMES.test(key)) return [key, value ? `${value.slice(0, 4)}…（${value.length} 位）` : ''];
      return [key, value.replace(/\/\/([^:/@]+):([^@]+)@/, '//$1:***@')];
    }),
  );
}
