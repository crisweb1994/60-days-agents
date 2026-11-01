// 第 10 天：mini-agent，一个能多轮对话的命令行 Agent。把前 9 天的成果都组装在一起。
// 运行：node days/day10/exercise/cli.ts
// 用 Anthropic 协议启动：MODEL_PROVIDER=anthropic node days/day10/exercise/cli.ts
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { describeStatus } from './agent.ts';
import { createModel, PROVIDERS, providerFromEnv, type Provider } from './providers.ts';
import { classifyError, withRetry, type ErrorKind } from './retry.ts';
import { createSession, type Session } from './session.ts';
import type { ApprovalRequest } from './tool.ts';
import { createTools } from './tools/index.ts';
import type { Model } from './types.ts';
import { calcCost, formatUsage, parsePrice, type Price, type Usage } from './usage.ts';

export interface CLIOptions {
  input: Readable;
  output: Writable;
  /** 读写文件的工具限制在这个目录里 */
  workspace: string;
  /** 一开始用哪种协议。不传就读环境变量 MODEL_PROVIDER，默认 openai */
  provider?: Provider;
}

export const HELP = `命令：
  /model [openai|anthropic]  查看或切换协议，对话历史保留
  /cost                      查看这次会话的用量和花费
  /clear                     清空对话历史，开始新的话题
  /help                      显示这段说明
  /exit                      退出（也可以按 Ctrl+D）
其他输入都会发给 Agent。回答的过程中按 Ctrl+C，可以中断这一轮。`;

const RETRY_REASONS: Record<ErrorKind, string> = {
  rate_limit: '请求太快被限流了',
  server: '模型服务出错了',
  timeout: '请求超时了',
  network: '网络出错了',
  quota: '额度不足',
  context_length: '输入太长',
  auth: 'API Key 不对',
  bad_request: '请求有问题',
  aborted: '已取消',
  unknown: '出错了',
};

/** 重试也救不回来的错误，告诉用户该怎么办 */
const ERROR_HINTS: Partial<Record<ErrorKind, string>> = {
  context_length: '对话太长了，超出了模型的上下文窗口。用 /clear 开始新的对话',
  auth: '检查 .env 里的 API Key',
  quota: '检查模型服务的账户余额',
};

/** 每种协议的单价，分别从 OPENAI_PRICE、ANTHROPIC_PRICE 读取（格式见 .env.example） */
function priceOf(provider: Provider): Price | undefined {
  return parsePrice(process.env[provider === 'anthropic' ? 'ANTHROPIC_PRICE' : 'OPENAI_PRICE']);
}

/** 工具参数太长时截断，确认时只给用户看个大概 */
function summarize(input: unknown): string {
  const json = JSON.stringify(input);
  return json.length > 200 ? `${json.slice(0, 200)}……` : json;
}

/**
 * 按行读输入。不直接用 rl.question：通过管道一次性输入好几行时，没人在等的那几行会丢掉。
 * 这里把收到的行先排队，谁要就给谁；等待时可以用 signal 取消
 */
function createLineReader(input: Readable, output: Writable) {
  const terminal = (input as { isTTY?: boolean }).isTTY === true;
  const rl = createInterface({ input, output, terminal });
  const queue: string[] = [];
  const waiters: ((line: string | undefined) => void)[] = [];
  let closed = false;
  // 不是终端（比如通过管道输入）时，输入的内容不会显示出来。读到一行就补显示一下，记录才好读
  const take = (line: string) => {
    if (!terminal) output.write(`${line}\n`);
    return line;
  };
  rl.on('line', (line) => {
    const waiter = waiters.shift();
    if (waiter) waiter(take(line));
    else queue.push(line);
  });
  rl.on('close', () => {
    closed = true;
    for (const waiter of waiters.splice(0)) waiter(undefined);
  });

  return {
    rl,
    /** 显示提示符，读下一行。输入结束或者被取消时返回 undefined */
    ask(prompt: string, signal?: AbortSignal): Promise<string | undefined> {
      rl.setPrompt(prompt);
      rl.prompt();
      const queued = queue.shift();
      if (queued !== undefined) return Promise.resolve(take(queued));
      if (closed || signal?.aborted) return Promise.resolve(undefined);
      return new Promise((resolve) => {
        const waiter = (line: string | undefined) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(line);
        };
        const onAbort = () => {
          waiters.splice(waiters.indexOf(waiter), 1);
          resolve(undefined);
        };
        waiters.push(waiter);
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    },
  };
}

/** 思考、回答、工具调用三种输出之间空一行；思考内容用暗色显示 */
function createPrinter(write: (text: string) => void) {
  let lastKind = '';
  return (kind: 'thinking' | 'text' | 'tool', text: string) => {
    if (lastKind && lastKind !== kind) write('\n\n');
    else if (kind === 'tool' && lastKind === 'tool') write('\n');
    lastKind = kind;
    write(kind === 'thinking' ? `\x1b[2m${text}\x1b[0m` : text);
  };
}

/** 运行 mini-agent，直到用户输入 /exit 或者输入结束。返回这次的会话，方便测试检查 */
export async function runCLI(options: CLIOptions): Promise<Session> {
  const { input, output, workspace } = options;
  const write = (text: string) => output.write(text);
  let provider = options.provider ?? providerFromEnv();
  let cost = 0; // 累计花费：每次调用按当时所用协议的单价计算
  let pricedAll = true; // 是不是每次调用都有单价

  const makeModel = (name: Provider): Model =>
    withRetry(createModel(name), {
      onRetry: ({ attempt, delayMs, kind, partial }) => {
        const restart = partial ? '，回答会从头重新生成' : '';
        write(`\n（${RETRY_REASONS[kind]}，${(delayMs / 1000).toFixed(1)} 秒后第 ${attempt} 次重试${restart}）\n`);
      },
    });
  const session = createSession({ model: makeModel(provider), tools: createTools(workspace) });
  const reader = createLineReader(input, output);
  let current: AbortController | undefined; // 正在进行的这一轮

  // 在终端里按 Ctrl+C：正在回答就中断这一轮，否则退出
  reader.rl.on('SIGINT', () => {
    if (current) current.abort();
    else reader.rl.close();
  });

  const countCost = (usage: Usage) => {
    const price = priceOf(provider);
    if (price) cost += calcCost(usage, price);
    else pricedAll = false;
  };
  const totals = () => {
    const money = cost > 0 ? ` · 约 ${cost.toFixed(4)} 元${pricedAll ? '' : '（有的调用没填单价，没算进去）'}` : '';
    return `${session.turns} 轮 · ${formatUsage(session.usage)}${money}`;
  };

  // 并行的工具调用可能同时要求确认：排成队，一个一个问
  let approvals = Promise.resolve(true);
  function confirm(request: ApprovalRequest, signal: AbortSignal): Promise<boolean> {
    // TODO 5：问用户同不同意执行这个工具调用。
    // - 并行的工具调用可能同时来问，要排队：每次都接在 approvals 后面（approvals.then(...)），再把新的 Promise 存回 approvals
    // - 先说明要做什么：工具名和参数（参数用 summarize 截短），再用 reader.ask('允许吗？(y/N) ', signal) 读用户的回答
    // - 只有明确回答 y 或 yes（不区分大小写）才返回 true；直接回车、输入别的、这一轮被取消了（signal），都返回 false
    return Promise.resolve(false);
  }

  function handleCommand(text: string): 'exit' | void {
    const [command, arg] = text.split(/\s+/);
    // TODO 4：处理其余的命令（/exit 已经写好了）：
    // - /help：显示 HELP
    // - /cost：显示 totals()，也就是轮数、累计用量和花费
    // - /clear：调用 session.clear()，告诉用户已经清空
    // - /model：没有参数时显示当前模型的名字（session.model.name）和可以切换的协议（PROVIDERS）；
    //   参数是 openai 或 anthropic 时，session.model 换成 makeModel(参数)，provider 也跟着改，告诉用户已经切换、历史保留。
    //   makeModel 可能抛错（比如 .env 里没填这种协议的配置），要接住并告诉用户；不认识的协议也要提示
    // - 其他：提示「不认识的命令」，建议输入 /help
    if (command === '/exit' || command === '/quit') return 'exit';
    write(`TODO 4：还没有实现命令 ${command}\n`);
  }

  async function runTurn(text: string) {
    const controller = new AbortController();
    current = controller;
    const print = createPrinter(write);
    try {
      const result = await session.send(text, {
        signal: controller.signal,
        onReasoning: (piece) => print('thinking', piece),
        onText: (piece) => print('text', piece),
        onToolCall: (call, toolResult) => {
          const status = toolResult.isError ? '✗' : '✓';
          print('tool', `${status} ${call.function.name} ${call.function.arguments}\n  ${toolResult.content.split('\n')[0]}`);
        },
        onUsage: countCost,
        confirm: (request) => confirm(request, controller.signal),
      });
      if (result.status !== 'completed') write(`\n\n（${describeStatus(result)}）`);
      write(`\n\n本轮：${formatUsage(result.usage, priceOf(provider))}\n`);
    } catch (error) {
      if (controller.signal.aborted) {
        write('\n（已中断，这一轮不会记进对话历史）\n');
      } else {
        const hint = ERROR_HINTS[classifyError(error).kind];
        write(`\n（出错了：${(error as Error).message}${hint ? `。${hint}` : ''}）\n`);
      }
    } finally {
      current = undefined;
    }
  }

  write(`mini-agent · ${session.model.name} · 工作目录 ${workspace}\n输入 /help 查看命令\n`);
  while (true) {
    const line = await reader.ask('\n你 > ');
    if (line === undefined) break; // 按了 Ctrl+D，或者管道里的输入读完了
    const text = line.trim();
    if (!text) continue;
    if (text.startsWith('/')) {
      if (handleCommand(text) === 'exit') break;
      continue;
    }
    await runTurn(text);
  }
  write(`\n再见！${totals()}\n`);
  reader.rl.close();
  return session;
}

if (import.meta.main) {
  try {
    process.loadEnvFile();
  } catch {
    // 没有 .env 文件时，就用终端里已经设置的环境变量
  }
  const workspace = resolve(process.env.AGENT_WORKSPACE ?? 'workspace');
  mkdirSync(workspace, { recursive: true });
  await runCLI({ input: process.stdin, output: process.stdout, workspace });
}
