import { describe, expect, test } from 'vitest';
import { loadTarget } from '#testing';
import type { SSEEvent } from '../solution/sse.ts';

const { parseSSE } = await loadTarget<typeof import('../solution/sse.ts')>(import.meta.url, 'sse.ts');

/** 把几段文字当成网络上先后到达的几块数据 */
async function* chunks(...parts: (string | Uint8Array)[]): AsyncGenerator<Uint8Array> {
  for (const part of parts) yield typeof part === 'string' ? new TextEncoder().encode(part) : part;
}

async function collect(stream: AsyncIterable<Uint8Array>): Promise<SSEEvent[]> {
  const events: SSEEvent[] = [];
  for await (const event of parseSSE(stream)) events.push(event);
  return events;
}

const datas = (events: SSEEvent[]) => events.map((event) => event.data);

describe('第 3 天：解析 SSE（TODO 1）', () => {
  test('一块里有一个完整的事件', async () => {
    expect(datas(await collect(chunks('data: {"n":1}\n\n')))).toEqual(['{"n":1}']);
  });

  test('一块里有好几个事件', async () => {
    const events = await collect(chunks('data: 1\n\ndata: 2\n\ndata: [DONE]\n\n'));
    expect(datas(events)).toEqual(['1', '2', '[DONE]']);
  });

  test('一个事件被拆进好几块：要等到空行才算结束', async () => {
    const events = await collect(chunks('da', 'ta: {"text":', '"你好"}', '\n', '\ndata: [DONE]\n\n'));
    expect(datas(events), '把没凑成完整一行的部分留到下一块再处理').toEqual(['{"text":"你好"}', '[DONE]']);
  });

  test('一个字节一个字节地到达，汉字的字节也被拆开了', async () => {
    const bytes = new TextEncoder().encode('data: {"text":"流式输出"}\n\ndata: 第二个事件\n\n');
    const oneByOne = Array.from(bytes, (byte) => new Uint8Array([byte]));
    const events = await collect(chunks(...oneByOne));
    expect(datas(events), '半行要留到下一块再处理；解码时要用 decoder.decode(chunk, { stream: true })，不然汉字会变成乱码').toEqual([
      '{"text":"流式输出"}',
      '第二个事件',
    ]);
  });

  test('换行可能是 \\r\\n', async () => {
    expect(datas(await collect(chunks('data: a\r\n\r\ndata: b\r\n\r\n')))).toEqual(['a', 'b']);
  });

  test('忽略注释行；记下 event: 字段', async () => {
    const events = await collect(chunks(': keep-alive\n\nevent: ping\ndata: {}\n\n'));
    expect(events, '以冒号开头的行是注释；只有注释、没有 data 的事件不用交出').toEqual([{ event: 'ping', data: '{}' }]);
  });

  test('一个事件有好几行 data 时，用换行连起来', async () => {
    expect(datas(await collect(chunks('data: 第一行\ndata: 第二行\n\n')))).toEqual(['第一行\n第二行']);
  });

  test('最后一个事件后面没有空行，流结束时也要交出来', async () => {
    expect(datas(await collect(chunks('data: 1\n\ndata: 2')))).toEqual(['1', '2']);
  });
});
