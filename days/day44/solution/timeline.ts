// 第 44 天：前端的状态。把服务器推来的一块块，归并成界面要画的时间线：每一步的文字、每次工具调用、深度研究的阶段、来源、最终的回答。
// 写成纯函数 applyChunk(状态, 块) → 新状态：不改旧的状态，同样的输入永远得到同样的输出，测试不用浏览器；
// React 里可以直接交给 useReducer，public/app.js 里每收到一块调用一次再重画。
// 这个文件会原样发给浏览器（web-server.ts 去掉类型以后），所以不能 import 别的文件，也不能用 Node 的 API。

/** 时间线上的一项 */
export type TimelineItem =
  | { kind: 'text'; id: string; text: string; done: boolean }
  | { kind: 'tool'; id: string; name: string; input: unknown; status: 'running' | 'done' | 'error'; output?: string }
  | { kind: 'progress'; id: string; label: string };

export interface Timeline {
  /** streaming：还在进行；done：完成了；error：出错了；aborted：被停止了 */
  status: 'idle' | 'streaming' | 'done' | 'error' | 'aborted';
  items: TimelineItem[];
  sources: { id: string; url: string; title: string }[];
  answer?: { text: string; status: string; note?: string };
  error?: string;
}

/** 收到的块。只列出时间线用得到的字段；不认识的块直接忽略（协议以后加了新的块，旧的界面也不会坏） */
export type Chunk = { type: string; [key: string]: unknown };

export function initialTimeline(): Timeline {
  return { status: 'idle', items: [], sources: [] };
}

/** 深度研究的阶段写成给人看的一句话 */
export function progressLabel(data: any): string {
  switch (data?.stage) {
    case 'plan':
      return `计划：${(data.subquestions ?? []).length} 个子问题`;
    case 'subagent':
      return `子问题 ${data.index + 1}「${data.question}」${data.status === 'completed' ? '查完了' : `没有查完（${data.status}）`}`;
    case 'report':
      return '正在写报告';
    case 'verify':
      return data.problems ? `核查：发现 ${data.problems} 处问题，已修改` : '核查：没有问题';
    default:
      return '进行中';
  }
}

/**
 * 归并一块，返回新的状态（不改旧的）：
 * - start：status 变成 streaming，清空之前的内容
 * - text-start：加一项文字；text-delta：找到同一个 id 的文字接上；text-end：标成 done
 * - tool-input-available：加一项工具调用，running；tool-output-available / tool-output-error：找到同一个 toolCallId，改成 done / error，记下结果
 * - data-progress：加一项进度；带 id 的，同一个 id 只留一项（后来的替换先来的）
 * - source-url：加一个来源（同一个 sourceId 不重复）
 * - data-answer：记下回答
 * - finish：没出错就是 done；error：status 是 error，记下 errorText；abort：aborted，还在 running 的工具调用改成 error
 */
export function applyChunk(state: Timeline, chunk: Chunk): Timeline {
  const items = state.items;
  const update = (match: (item: TimelineItem) => boolean, change: (item: any) => TimelineItem): TimelineItem[] => items.map((item) => (match(item) ? change(item) : item));
  switch (chunk.type) {
    case 'start':
      return { status: 'streaming', items: [], sources: [] };
    case 'text-start':
      return { ...state, items: [...items, { kind: 'text', id: String(chunk.id), text: '', done: false }] };
    case 'text-delta':
      return { ...state, items: update((i) => i.kind === 'text' && i.id === chunk.id, (i) => ({ ...i, text: i.text + String(chunk.delta ?? '') })) };
    case 'text-end':
      return { ...state, items: update((i) => i.kind === 'text' && i.id === chunk.id, (i) => ({ ...i, done: true })) };
    case 'tool-input-available':
      return { ...state, items: [...items, { kind: 'tool', id: String(chunk.toolCallId), name: String(chunk.toolName), input: chunk.input, status: 'running' }] };
    case 'tool-output-available':
      return { ...state, items: update((i) => i.kind === 'tool' && i.id === chunk.toolCallId, (i) => ({ ...i, status: 'done', output: typeof chunk.output === 'string' ? chunk.output : JSON.stringify(chunk.output) })) };
    case 'tool-output-error':
      return { ...state, items: update((i) => i.kind === 'tool' && i.id === chunk.toolCallId, (i) => ({ ...i, status: 'error', output: String(chunk.errorText ?? '') })) };
    case 'data-progress': {
      const id = typeof chunk.id === 'string' ? chunk.id : `progress-${items.length}`;
      const item: TimelineItem = { kind: 'progress', id, label: progressLabel(chunk.data) };
      const exists = items.some((i) => i.kind === 'progress' && i.id === id);
      return { ...state, items: exists ? update((i) => i.kind === 'progress' && i.id === id, () => item) : [...items, item] };
    }
    case 'source-url':
      if (state.sources.some((s) => s.id === chunk.sourceId)) return state;
      return { ...state, sources: [...state.sources, { id: String(chunk.sourceId), url: String(chunk.url), title: String(chunk.title ?? chunk.url) }] };
    case 'data-answer':
      return { ...state, answer: chunk.data as Timeline['answer'] };
    case 'error':
      return { ...state, status: 'error', error: String(chunk.errorText ?? '') };
    case 'abort':
      return { ...state, status: 'aborted', items: update((i) => i.kind === 'tool' && i.status === 'running', (i) => ({ ...i, status: 'error', output: '已停止' })) };
    case 'finish':
      return state.status === 'error' ? state : { ...state, status: 'done' };
    default:
      return state;
  }
}

/**
 * 从 SSE 的文字里一块块取出 JSON。浏览器和 Node 都能用：把收到的文字交给 push，返回这次凑齐的块；
 * [DONE] 和注释行（: ping）忽略。和第 3 天的 parseSSE 一样要处理「一个事件被拆在两次里」
 */
export function createSSEDecoder() {
  let buffer = '';
  return {
    push(text: string): Chunk[] {
      buffer += text;
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() ?? '';
      const chunks: Chunk[] = [];
      for (const event of events) {
        const data = event
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (!data || data === '[DONE]') continue;
        try {
          chunks.push(JSON.parse(data));
        } catch {
          // 解析不了的事件跳过
        }
      }
      return chunks;
    },
  };
}
