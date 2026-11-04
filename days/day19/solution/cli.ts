// 第 10 天：mini-agent，一个能多轮对话的命令行 Agent。把前 9 天的成果都组装在一起。
// 第 12 天：能联网搜索、读网页，回答后面附上引用的来源。
// 第 13 天：从 mcp.json 加载 MCP 服务器，它们的工具和内置的工具一起用。
// 第 15 天：按预算组装上下文，日期作为动态信息放在问题前面；/context 查看上下文的构成，/cost 显示缓存命中率。
// 第 16 天：大的工具结果写进文件；历史超过窗口的 60% 时自动压缩，/compact 手动压缩。
// 第 19 天：长期记忆（/memory），每一轮结束自动保存会话，/sessions 列出、/resume 恢复。
// 运行：node days/day10/solution/cli.ts
// 用 Anthropic 协议启动：MODEL_PROVIDER=anthropic node days/day10/solution/cli.ts
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { describeStatus } from './agent.ts';
import { offloadLargeResults } from './compact.ts';
import { createMemoryStore, memorySection } from './memory.ts';
import { createSessionStore, newSessionId, titleOf, type SavedSession } from './session-store.ts';
import { createMemoryTools } from './tools/memory.ts';
import { cacheStats } from './context.ts';
import { dateSection } from './prompts.ts';
import { connectMcpServers, loadMcpConfig, type McpHost } from './mcp.ts';
import { createModel, PROVIDERS, providerFromEnv, type Provider } from './providers.ts';
import { classifyError, withRetry, type ErrorKind } from './retry.ts';
import { createSession, type CompactInfo, type Session } from './session.ts';
import type { ApprovalRequest } from './tool.ts';
import { searchProviderFromEnv, type SearchProvider } from './search.ts';
import { createTools } from './tools/index.ts';
import type { Model } from './types.ts';
import { calcCost, formatUsage, parsePrice, type Price, type Usage } from './usage.ts';
import { createSourceRegistry, formatReferences, RESEARCH_PROMPT } from './web.ts';

export interface CLIOptions {
  input: Readable;
  output: Writable;
  /** 读写文件的工具限制在这个目录里 */
  workspace: string;
  /** 一开始用哪种协议。不传就读环境变量 MODEL_PROVIDER，默认 openai */
  provider?: Provider;
  /** 搜索服务。不传就读环境变量 SEARCH_PROVIDER；传 null 表示不用搜索（第 12 天） */
  search?: SearchProvider | null;
  /** 已经连接好的 MCP 服务器（第 13 天） */
  mcp?: McpHost;
  /** 模型的上下文窗口，单位 token。不传就读环境变量 CONTEXT_WINDOW，默认 64000（第 15 天） */
  contextWindow?: number;
  /** 当前时间，测试时换成固定的（第 15 天） */
  now?: () => Date;
  /** 记忆和会话存在哪里，默认在工作目录的 .mini-agent/ 下面（第 19 天） */
  memoryDir?: string;
  sessionsDir?: string;
  /** 启动时恢复这个会话（第 19 天） */
  resume?: string;
}

export const HELP = `命令：
  /model [openai|anthropic]  查看或切换协议，对话历史保留
  /cost                      查看这次会话的用量和花费
  /memory                    列出记住的事
  /sessions                  列出保存的会话
  /resume <id>               恢复一个保存的会话
  /sources                   列出这次会话里搜到、读过的网页
  /mcp                       列出 MCP 服务器和它们的工具
  /context                   查看上一轮的上下文由哪些部分组成
  /compact                   把较早的对话压缩成摘要
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
  const contextWindow = options.contextWindow ?? Number(process.env.CONTEXT_WINDOW || 64_000);
  const search = options.search === undefined ? searchProviderFromEnv() : (options.search ?? undefined);
  const sources = createSourceRegistry();
  const now = options.now ?? (() => new Date());
  const memory = createMemoryStore(options.memoryDir ?? join(workspace, '.mini-agent', 'memory'), now);
  const sessions = createSessionStore(options.sessionsDir ?? join(workspace, '.mini-agent', 'sessions'));
  // 太长的工具结果写进工作目录的 .context/results/，上下文里只放开头和文件的位置
  const tools = offloadLargeResults(
    [...createTools(workspace, { search, sources }), ...createMemoryTools(memory), ...(options.mcp?.tools ?? [])],
    { workspace },
  );
  const makeSession = (model: Model, restore?: SavedSession) =>
    createSession({
      model,
      tools,
      system: RESEARCH_PROMPT,
      budget: { contextWindow },
      compact: { thresholdTokens: Math.floor(contextWindow * 0.6) },
      restore,
    });
  let session = makeSession(makeModel(provider));
  let sessionId = newSessionId(now());
  let createdAt = now().toISOString();

  /** 每一轮结束就保存。保存失败只提示，不影响接着聊 */
  async function saveSession() {
    try {
      await sessions.save({
        id: sessionId,
        title: titleOf(session.messages),
        model: session.model.name,
        messages: session.messages,
        usage: session.usage,
        turns: session.turns,
        created: createdAt,
        updated: now().toISOString(),
      });
    } catch (error) {
      write(`（保存会话失败：${(error as Error).message}）\n`);
    }
  }

  /** 恢复一个保存的会话：历史、用量、轮数都接上，模型用现在的 */
  async function resume(id: string) {
    const saved = await sessions.load(id);
    session = makeSession(session.model, saved);
    sessionId = saved.id;
    createdAt = saved.created;
    write(`已恢复会话 ${saved.id}：${saved.title}（${saved.turns} 轮${saved.model !== session.model.name ? `，当时用的是 ${saved.model}` : ''}）\n`);
  }
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
    const { hitRate } = cacheStats([session.usage]);
    return `${session.turns} 轮 · ${formatUsage(session.usage)} · 缓存命中率 ${Math.round(hitRate * 100)}%${money}`;
  };

  // 并行的工具调用可能同时要求确认：排成队，一个一个问
  let approvals = Promise.resolve(true);
  function confirm(request: ApprovalRequest, signal: AbortSignal): Promise<boolean> {
    const next = approvals.then(async () => {
      if (signal.aborted) return false;
      write(`\n要执行 ${request.tool} ${summarize(request.input)}\n`);
      const answer = await reader.ask('允许吗？(y/N) ', signal);
      // 只有明确回答 y 才执行，直接回车、输入别的都当作不同意
      return ['y', 'yes'].includes(answer?.trim().toLowerCase() ?? '');
    });
    approvals = next.catch(() => false);
    return next;
  }

  /** 显示一次压缩的结果 */
  const describeCompact = (info: CompactInfo) =>
    info.kind === 'summary'
      ? `（把较早的 ${info.compactedTurns} 轮对话压缩成了摘要，历史从约 ${info.before} 减少到 ${info.after} tokens）`
      : `（清理了 ${info.pruned} 个旧的工具输出，历史从约 ${info.before} 减少到 ${info.after} tokens）`;

  async function handleCommand(text: string): Promise<'exit' | 'compact' | void> {
    const [command, arg] = text.split(/\s+/);
    switch (command) {
      case '/exit':
      case '/quit':
        return 'exit';
      case '/help':
        write(`${HELP}\n`);
        return;
      case '/cost':
        write(`${totals()}\n`);
        return;
      case '/sources': {
        const list = sources.list();
        write(list.length ? `${list.map((s) => `[${s.id}] ${s.title || '（无标题）'} ${s.url}`).join('\n')}\n` : '还没有搜到或读过网页\n');
        return;
      }
      case '/mcp': {
        const servers = options.mcp?.servers ?? [];
        if (servers.length === 0) {
          write('没有配置 MCP 服务器。在 mcp.json 里配置，或者用环境变量 MCP_CONFIG 指定配置文件\n');
          return;
        }
        for (const server of servers) {
          if (server.status === 'failed') write(`✗ ${server.name}：连接失败，${server.error}\n`);
          else {
            write(`✓ ${server.name}（${server.serverInfo ?? '未知'}，协议 ${server.protocolVersion}）：${server.tools.join('、') || '没有工具'}\n`);
            if (server.error) write(`  ${server.error}\n`);
          }
        }
        return;
      }
      case '/context': {
        const report = session.lastContext;
        if (!report) {
          write('还没有对话\n');
          return;
        }
        const rows = [
          ['system prompt', report.system],
          ['工具定义', report.tools],
          ['对话历史', report.history],
          ['动态信息', report.dynamic],
          ['问题', report.question],
        ] as const;
        for (const [name, tokens] of rows) write(`${name.padEnd(14)}${String(tokens).padStart(7)} tokens\n`);
        write(`${'合计（估算）'.padEnd(12)}${String(report.total).padStart(7)} / ${report.limit} tokens\n`);
        if (report.droppedTurns) write(`为了放进预算，删掉了最早的 ${report.droppedTurns} 轮对话\n`);
        if (report.droppedSections.length) write(`放不下的动态信息：${report.droppedSections.join('、')}\n`);
        return;
      }
      case '/compact':
        return 'compact';
      case '/clear':
        // 开始一个新的会话。之前的会话已经保存了，可以用 /resume 回去
        session = makeSession(session.model);
        sessionId = newSessionId(now());
        createdAt = now().toISOString();
        write('已开始新的对话。之前的对话已经保存，可以用 /resume 恢复\n');
        return;
      case '/memory': {
        const memories = await memory.list();
        write(memories.length ? `${memories.map((m) => `- ${m.name}（${m.type}）：${m.content}`).join('\n')}\n` : '还没有记住任何事\n');
        return;
      }
      case '/sessions': {
        const list = await sessions.list();
        if (list.length === 0) write('还没有保存的会话\n');
        for (const s of list) write(`${s.id === sessionId ? '*' : ' '} ${s.id}  ${s.updated.slice(0, 16).replace('T', ' ')}  ${s.turns} 轮  ${s.title}\n`);
        return;
      }
      case '/resume':
        if (!arg) {
          write('用法：/resume <id>，id 用 /sessions 查看\n');
          return;
        }
        try {
          await resume(arg);
        } catch (error) {
          write(`恢复失败：${(error as Error).message}\n`);
        }
        return;
      case '/model': {
        if (!arg) {
          write(`当前模型：${session.model.name}。可以切换的协议：${PROVIDERS.join('、')}\n`);
          return;
        }
        if (!PROVIDERS.includes(arg as Provider)) {
          write(`不认识的协议：${arg}。可以切换的协议：${PROVIDERS.join('、')}\n`);
          return;
        }
        try {
          session.model = makeModel(arg as Provider);
          provider = arg as Provider;
          write(`已切换到 ${session.model.name}，对话历史保留\n`);
        } catch (error) {
          write(`切换失败：${(error as Error).message}\n`); // 比如 .env 里没填这种协议的配置
        }
        return;
      }
      default:
        write(`不认识的命令：${command}。输入 /help 查看可用的命令\n`);
    }
  }

  async function runTurn(text: string) {
    const controller = new AbortController();
    current = controller;
    const print = createPrinter(write);
    try {
      const remembered = await memorySection(memory);
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
        dynamic: [dateSection(now()), ...(remembered ? [remembered] : [])],
        onCompact: (info) => write(`${describeCompact(info)}\n\n`),
      });
      // 回答里引用了 [编号]，在后面列出这些来源。编号对不上的，提醒用户这可能是模型编的
      const { cited, unknown } = formatReferences(result.answer, sources);
      if (cited.length) write(`\n\n来源：\n${cited.map((s) => `[${s.id}] ${s.title || '（无标题）'} ${s.url}`).join('\n')}`);
      if (unknown.length) write(`\n\n（注意：回答里的 ${unknown.map((id) => `[${id}]`).join('')} 不是查到过的来源）`);
      if (result.status !== 'completed') write(`\n\n（${describeStatus(result)}）`);
      write(`\n\n本轮：${formatUsage(result.usage, priceOf(provider))}\n`);
      await saveSession();
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

  const searchInfo = search ? `搜索 ${search.name}` : '没有配置搜索（见 .env.example 的 SEARCH_PROVIDER）';
  write(`mini-agent · ${session.model.name} · ${searchInfo} · 工作目录 ${workspace}\n输入 /help 查看命令\n`);
  const servers = options.mcp?.servers ?? [];
  if (servers.length) {
    const ok = servers.filter((s) => s.status === 'connected').length;
    write(`MCP 服务器：连上了 ${ok}/${servers.length} 个，共 ${options.mcp!.tools.length} 个工具${ok < servers.length ? '（用 /mcp 查看原因）' : ''}\n`);
  }
  if (options.resume) {
    try {
      await resume(options.resume);
    } catch (error) {
      write(`恢复失败：${(error as Error).message}。开始新的对话\n`);
    }
  }
  while (true) {
    const line = await reader.ask('\n你 > ');
    if (line === undefined) break; // 按了 Ctrl+D，或者管道里的输入读完了
    const text = line.trim();
    if (!text) continue;
    if (text.startsWith('/')) {
      const action = await handleCommand(text);
      if (action === 'exit') break;
      if (action === 'compact') {
        try {
          const info = await session.compact({ force: true });
          write(info ? `${describeCompact(info)}\n` : '对话还很短，不用压缩\n');
        } catch (error) {
          write(`压缩失败：${(error as Error).message}\n`);
        }
      }
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
  // MCP 服务器的配置默认在当前目录的 mcp.json，也可以用 MCP_CONFIG 指定
  const config = await loadMcpConfig(process.env.MCP_CONFIG ?? 'mcp.json');
  const mcp = config ? await connectMcpServers(config) : undefined;
  try {
    // node cli.ts --resume <id>：启动时恢复一个会话
    const at = process.argv.indexOf('--resume');
    const resumeId = at === -1 ? undefined : process.argv[at + 1];
    await runCLI({ input: process.stdin, output: process.stdout, workspace, mcp, resume: resumeId });
  } finally {
    await mcp?.close();
  }
}
