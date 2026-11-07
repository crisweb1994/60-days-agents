// 第 38 天：沙箱。让研究助手能执行代码（算统计、处理 CSV、画个表），但代码是模型写的，可能被注入的网页影响（第 37 天），
// 也可能只是写错了（死循环、把内存吃光）。所以代码不在我们的进程里跑，而是放进一个用完即扔的 Docker 容器：
//   断网（--network none）：数据发不出去
//   限资源（内存、CPU、进程数）：死循环、fork 炸弹拖不垮机器
//   只读的文件系统，只挂载工作目录、而且只读：改不了也删不了你的文件
//   不用 root、去掉所有特权：就算有内核漏洞，能做的也少
//   有超时：到点就 docker kill
// 运行：node days/day38/solution/sandbox.ts python "print(sum(range(10)))"
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { defineTool, truncate } from './tool.ts';

export const LANGUAGES = ['javascript', 'python'] as const;
export type Language = (typeof LANGUAGES)[number];

export interface SandboxOptions {
  /** 每种语言用哪个镜像。默认 node:22-alpine 和 python:3.12-slim，可以用 SANDBOX_NODE_IMAGE、SANDBOX_PYTHON_IMAGE 换 */
  images?: Partial<Record<Language, string>>;
  /** 内存上限，默认 256m。同时把 swap 也限制成一样大，免得用 swap 绕过 */
  memory?: string;
  /** CPU 上限，默认 0.5 个核 */
  cpus?: string;
  /** 最多几个进程，默认 64：fork 炸弹到这里就停了 */
  pidsLimit?: number;
  /** 超时，默认 10 秒 */
  timeoutMs?: number;
  /** 输出最多保留多少个字符，默认 8000 */
  maxOutputChars?: number;
  /** 挂载进容器的目录（只读），容器里的路径是 /workspace。不填就不挂载任何目录 */
  workspace?: string;
  /** 跑命令的方式，默认真的启动 docker。测试时可以换成假的 */
  runner?: Runner;
}

export const DEFAULT_IMAGES: Record<Language, string> = {
  javascript: process.env.SANDBOX_NODE_IMAGE || 'node:22-alpine',
  python: process.env.SANDBOX_PYTHON_IMAGE || 'python:3.12-slim',
};

/** 每种语言在容器里怎么运行：代码从标准输入读，不用写临时文件 */
const COMMANDS: Record<Language, string[]> = {
  javascript: ['node', '-'],
  python: ['python3', '-'],
};

/**
 * docker run 的参数。顺序：
 * run --rm -i --name 名字 --network none --memory M --memory-swap M --cpus C --pids-limit P
 * --read-only --tmpfs /tmp:rw,size=64m --cap-drop ALL --security-opt no-new-privileges --user 65534:65534
 * [-v 工作目录:/workspace:ro -w /workspace] 镜像 命令……
 */
export function dockerArgs(language: Language, name: string, options: SandboxOptions = {}): string[] {
  const { images = {}, memory = '256m', cpus = '0.5', pidsLimit = 64, workspace } = options;
  const image = images[language] ?? DEFAULT_IMAGES[language];
  return [
    'run',
    '--rm',
    '-i',
    '--name',
    name,
    '--network',
    'none',
    '--memory',
    memory,
    '--memory-swap',
    memory,
    '--cpus',
    cpus,
    '--pids-limit',
    String(pidsLimit),
    '--read-only',
    '--tmpfs',
    '/tmp:rw,size=64m',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--user',
    '65534:65534',
    ...(workspace ? ['-v', `${workspace}:/workspace:ro`, '-w', '/workspace'] : []),
    image,
    ...COMMANDS[language],
  ];
}

export interface RunOutput {
  stdout: string;
  stderr: string;
  /** 退出码。被杀掉时可能是 null */
  exitCode: number | null;
  timedOut: boolean;
}

/** 跑一个命令：command 和 args，代码从 input 交给它的标准输入。到了 timeoutMs 还没结束，调用 onTimeout，再把进程杀掉 */
export type Runner = (command: string, args: string[], options: { input: string; timeoutMs: number; onTimeout?: () => Promise<void> }) => Promise<RunOutput>;

/** 真的启动进程 */
export const spawnRunner: Runner = (command, args, { input, timeoutMs, onTimeout }) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    // 输出太多也要截住，免得一段 while(true) print 把内存吃光
    const LIMIT = 1_000_000;
    child.stdout.on('data', (d) => (stdout = (stdout + d).slice(0, LIMIT)));
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(0, LIMIT)));
    const timer = setTimeout(async () => {
      timedOut = true;
      await onTimeout?.().catch(() => {});
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode, timedOut });
    });
    child.stdin.on('error', () => {}); // 进程提前退出时，写标准输入会报 EPIPE，忽略
    child.stdin.end(input);
  });

export interface SandboxResult extends RunOutput {
  /** 输出被截断了 */
  truncated: boolean;
}

export interface Sandbox {
  run(language: Language, code: string): Promise<SandboxResult>;
}

/**
 * 创建沙箱。每次 run 一个新容器，名字是 sandbox- 加上随机的十六进制；超时时先 docker kill 这个容器
 * （只杀 docker 命令行的进程，容器可能还在跑），再杀进程。
 * stdout 和 stderr 各自最多保留 maxOutputChars 个字符（用 truncate），有一个被截断了 truncated 就是 true
 */
export function createSandbox(options: SandboxOptions = {}): Sandbox {
  const { timeoutMs = 10_000, maxOutputChars = 8000, runner = spawnRunner } = options;
  return {
    async run(language, code) {
      const name = `sandbox-${randomBytes(6).toString('hex')}`;
      const onTimeout = async () => {
        await runner('docker', ['kill', name], { input: '', timeoutMs: 5000 });
      };
      const out = await runner('docker', dockerArgs(language, name, options), { input: code, timeoutMs, onTimeout });
      const truncated = out.stdout.length > maxOutputChars || out.stderr.length > maxOutputChars;
      return { ...out, stdout: truncate(out.stdout, maxOutputChars), stderr: truncate(out.stderr, maxOutputChars), truncated };
    },
  };
}

/** 结果排成给模型看的文字 */
export function formatRunResult(result: SandboxResult, timeoutMs: number): string {
  const lines: string[] = [];
  if (result.timedOut) lines.push(`超时了（${timeoutMs / 1000} 秒），已经停止。是不是有死循环？`);
  else lines.push(`退出码 ${result.exitCode}`);
  if (result.stdout) lines.push(`标准输出：\n${result.stdout}`);
  if (result.stderr) lines.push(`标准错误：\n${result.stderr}`);
  if (!result.stdout && !result.stderr) lines.push('（没有输出。要看结果，记得 print 或者 console.log）');
  return lines.join('\n');
}

/**
 * run_code 工具。代码在断网、只读的容器里跑，最坏也只能把容器搞坏，所以风险等级算 read，不用每次问用户：
 * 沙箱的意义就在这里，把「执行任意代码」的风险降到「只读」
 */
export function createCodeTool(sandbox: Sandbox, { timeoutMs = 10_000 }: { timeoutMs?: number } = {}) {
  return defineTool({
    name: 'run_code',
    description:
      '在隔离的容器里运行一段 JavaScript 或 Python 代码，返回输出。用来做计算、统计、处理数据。' +
      '容器没有网络，不能联网、不能安装包；工作目录的文件在 /workspace 下面，只读；只能写 /tmp。结果要打印出来才看得到',
    risk: 'read',
    schema: z.object({
      language: z.enum(LANGUAGES).describe('javascript 或 python'),
      code: z.string().min(1).describe('完整的代码'),
    }),
    async execute({ language, code }) {
      return formatRunResult(await sandbox.run(language, code), timeoutMs);
    },
  });
}

/** 本机能不能用 docker：docker 命令在、守护进程在跑 */
export async function dockerAvailable(): Promise<boolean> {
  try {
    const out = await spawnRunner('docker', ['version', '--format', '{{.Server.Version}}'], { input: '', timeoutMs: 5000 });
    return out.exitCode === 0;
  } catch {
    return false;
  }
}

/** 镜像是不是已经在本机了。测试只用已经有的镜像，不替你下载 */
export async function imageAvailable(image: string): Promise<boolean> {
  try {
    return (await spawnRunner('docker', ['image', 'inspect', image], { input: '', timeoutMs: 5000 })).exitCode === 0;
  } catch {
    return false;
  }
}

if (import.meta.main) {
  const [language, code] = process.argv.slice(2);
  if (!LANGUAGES.includes(language as Language) || !code) {
    console.error('用法：sandbox.ts <javascript|python> <代码>');
    process.exit(1);
  }
  console.log(formatRunResult(await createSandbox().run(language as Language, code), 10_000));
}
