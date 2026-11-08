// 第 56 天：上线前的检查清单。能自动检查的写成代码（每次发布前都跑，可以放进 CI），不能的列出来让人确认。
//   密钥扫描：提交里不能有 API Key、令牌、私钥。只扫 git 跟踪的文件：本机的 .env 本来就不提交
//   .env.example：代码要读的配置都列出来了（新人照着它就能跑起来），而且里面没有填真的密钥
// 这些检查都很朴素（几个正则），挡住的是最常见的失误。更完整的扫描用 gitleaks、trufflehog，或者 GitHub 的 Secret scanning。
// 第 56 天的练习：TODO 5、6 在这里。检查：npm run check 56
import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

export interface SecretRule {
  id: string;
  pattern: RegExp;
}

/** 常见的密钥格式。最后一条是「名字像密钥的变量被赋了一个长字符串」，要排除占位符 */
export const SECRET_RULES: SecretRule[] = [
  { id: 'private-key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
  { id: 'openai-style-key', pattern: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { id: 'github-token', pattern: /\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{22,}/ },
  { id: 'aws-access-key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'slack-token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { id: 'assigned-secret', pattern: /\b[\w-]*(?:api[_-]?key|secret|token|password|passwd)[\w-]*["']?\s*[:=]\s*["']([^"'\s]{12,})["']/i },
];

/** 一看就是占位符的值：your-xxx、xxxx、<…>、${…}、example、changeme、dummy、test 开头 */
const PLACEHOLDER = /^(?:your[-_]|<.*>$|\$\{|x{4,}|\*{4,})|example|changeme|placeholder|dummy|^test[-_]/i;

export interface SecretFinding {
  path: string;
  /** 从 1 开始 */
  line: number;
  rule: string;
  /** 打码以后的样子：前 4 个字符加「…」，不把密钥再打印一遍 */
  preview: string;
}

/**
 * 扫描密钥（TODO 5）。每个文件逐行，每一行按 SECRET_RULES 的顺序找，**一行最多报一条**（第一条命中的规则）：
 * - assigned-secret 规则：取第一个捕获组作为密钥；它是占位符（PLACEHOLDER）就不算
 * - 其他规则：整个匹配就是密钥
 * - 行里有 `preflight-ignore` 的跳过（明知是假的、测试用的，显式标出来）
 * preview 是密钥的前 4 个字符加「…」。按文件的顺序、行号的顺序返回
 */
export function scanSecrets(files: { path: string; content: string }[]): SecretFinding[] {
  // TODO 5：每个文件按行（/\r?\n/）扫；有 preflight-ignore 的行跳过；按 SECRET_RULES 的顺序用 rule.pattern.exec(行)，
  // 第一条真正命中的（assigned-secret 要排除占位符）记下来，这一行就不再看别的规则
  void SECRET_RULES; void PLACEHOLDER; void files;
  return [];
}

/** 从 .env 格式的文本里读出键和值（忽略注释和空行；值去掉两边的引号） */
export function parseEnvKeys(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    out.set(m[1], m[2].trim().replace(/^(['"])(.*)\1$/, '$2'));
  }
  return out;
}

/** 名字像密钥的配置 */
const SECRET_NAME = /KEY|SECRET|TOKEN|PASSWORD/i;

/**
 * 检查 .env.example（TODO 6）：
 * - missing：代码要的配置（required，按它的顺序），example 里没有的
 * - unknown：example 里有、代码不要的（按 example 里的顺序）。多半是改名以后忘了删
 * - filled：名字像密钥（SECRET_NAME）、又填了值、而且值不是占位符（PLACEHOLDER）的。example 会被提交，这里不能有真的密钥
 * ok 是三个都空
 */
export function checkEnvExample(required: string[], example: string): { ok: boolean; missing: string[]; unknown: string[]; filled: string[] } {
  // TODO 6：用 parseEnvKeys 读出 example 的键和值，按注释算出 missing、unknown、filled
  void parseEnvKeys; void SECRET_NAME; void required; void example;
  return { ok: true, missing: [], unknown: [], filled: [] };
}

const SKIP = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage']);
const MAX_SCAN_BYTES = 1024 * 1024;

/** git 跟踪的文件（git ls-files）；不是 git 仓库时，退回去遍历目录（跳过 SKIP） */
export async function listTrackedFiles(root: string): Promise<string[]> {
  try {
    const { stdout } = await promisify(execFile)('git', ['ls-files', '-z'], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
    return stdout.split('\0').filter(Boolean).sort();
  } catch {
    const out: string[] = [];
    const walk = async (dir: string, prefix: string) => {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        if (e.isDirectory() && !SKIP.has(e.name)) await walk(join(dir, e.name), `${prefix}${e.name}/`);
        else if (e.isFile()) out.push(`${prefix}${e.name}`);
      }
    };
    await walk(root, '');
    return out.sort();
  }
}

/** 读出要扫描的文件：太大的、二进制的跳过 */
export async function readTextFiles(root: string, paths: string[]): Promise<{ path: string; content: string }[]> {
  const files: { path: string; content: string }[] = [];
  for (const path of paths) {
    const full = join(root, path);
    const info = await stat(full).catch(() => undefined);
    if (!info?.isFile() || info.size > MAX_SCAN_BYTES) continue;
    const content = await readFile(full, 'utf8');
    if (!content.includes('\0')) files.push({ path, content });
  }
  return files;
}

export interface CheckItem {
  id: string;
  title: string;
  /** 能自动检查的：返回过没过和一句说明 */
  check?: () => Promise<{ ok: boolean; detail: string }>;
  /** 不能自动检查的：要人确认的事 */
  manual?: string;
}

export interface CheckResult {
  id: string;
  title: string;
  status: 'pass' | 'fail' | 'manual';
  detail: string;
}

/** 跑清单：自动的跑一遍（抛错算没过），人工的列出来。ok 是「没有 fail」 */
export async function runChecklist(items: CheckItem[]): Promise<{ ok: boolean; results: CheckResult[] }> {
  const results: CheckResult[] = [];
  for (const item of items) {
    if (!item.check) {
      results.push({ id: item.id, title: item.title, status: 'manual', detail: item.manual ?? '' });
      continue;
    }
    try {
      const r = await item.check();
      results.push({ id: item.id, title: item.title, status: r.ok ? 'pass' : 'fail', detail: r.detail });
    } catch (error) {
      results.push({ id: item.id, title: item.title, status: 'fail', detail: `检查出错：${(error as Error).message}` });
    }
  }
  return { ok: !results.some((r) => r.status === 'fail'), results };
}

export function renderChecklist(results: CheckResult[]): string {
  const icon = { pass: '✅', fail: '❌', manual: '☐' } as const;
  return results.map((r) => `${icon[r.status]} ${r.title}${r.detail ? `：${r.detail}` : ''}`).join('\n');
}

/** review-bot 的上线清单。你的项目照着改：能自动检查的尽量写成代码 */
export function reviewBotChecklist(root: string, options: { requiredEnv: string[]; envExample?: string; spend?: { daily: number; monthly: number } }): CheckItem[] {
  return [
    {
      id: 'secrets',
      title: '提交里没有密钥',
      check: async () => {
        const findings = scanSecrets(await readTextFiles(root, await listTrackedFiles(root)));
        return { ok: !findings.length, detail: findings.length ? findings.map((f) => `${f.path}:${f.line}（${f.rule}，${f.preview}）`).join('、') : '没有发现' };
      },
    },
    {
      id: 'env-example',
      title: '.env.example 列全了配置，没有真的密钥',
      check: async () => {
        const r = checkEnvExample(options.requiredEnv, options.envExample ?? (await readFile(join(root, '.env.example'), 'utf8')));
        const parts = [r.missing.length && `缺少 ${r.missing.join('、')}`, r.unknown.length && `多余 ${r.unknown.join('、')}`, r.filled.length && `填了值 ${r.filled.join('、')}`].filter(Boolean);
        return { ok: r.ok, detail: parts.join('；') || '没有问题' };
      },
    },
    {
      id: 'spend',
      title: '设了花费上限',
      check: async () => ({ ok: !!options.spend && options.spend.daily > 0 && options.spend.monthly >= options.spend.daily, detail: options.spend ? `每天 ${options.spend.daily} 元，每月 ${options.spend.monthly} 元` : '没有设置' }),
    },
    { id: 'permissions', title: 'GitHub App 只有最小的权限', manual: 'Contents 只读、Pull requests 读写、Metadata 只读；不要 Administration、Workflows' },
    { id: 'eval', title: '评估达标', manual: '第 55 天的成功标准在开发集上全部达标，测试集确认过一次' },
    { id: 'alerts', title: '告警能收到', manual: '故意弄错一次模型的 Key，群里几分钟内收到告警（第 49、50 天）' },
    { id: 'rollback', title: '能回滚', manual: '知道怎么退回上一个镜像（第 48 天）、上一版 prompt（第 49 天）' },
    { id: 'privacy', title: '说清楚数据去了哪里', manual: '代码会发给哪家模型服务、存多久；README 里写明' },
  ];
}

/** review-bot 要的配置。你的项目换成自己的（可以从 config 的 schema 里取） */
export const REVIEW_BOT_ENV = ['MODEL_PROVIDER', 'OPENAI_BASE_URL', 'OPENAI_API_KEY', 'OPENAI_MODEL', 'CHEAP_MODEL', 'OPENAI_PRICE', 'CHEAP_PRICE', 'GITHUB_TOKEN', 'WEBHOOK_SECRET', 'ALLOWED_REPOS', 'SPEND_DAILY', 'SPEND_MONTHLY'];

// 运行：node days/day56/exercise/preflight.ts [项目目录]，有没过的检查时退出码是 1
if (import.meta.main) {
  const root = process.argv[2] ?? '.';
  const spend = process.env.SPEND_DAILY ? { daily: Number(process.env.SPEND_DAILY), monthly: Number(process.env.SPEND_MONTHLY) } : undefined;
  const { ok, results } = await runChecklist(reviewBotChecklist(root, { requiredEnv: REVIEW_BOT_ENV, spend }));
  console.log(renderChecklist(results));
  process.exit(ok ? 0 : 1);
}
