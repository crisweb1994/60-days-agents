import { expect, test } from 'vitest';
import { describeE2E, describeMock, loadTarget, setupModel } from '#testing';

const llm = await setupModel();
const { chat, chatStream } = await loadTarget<typeof import('../solution/openai.ts')>(import.meta.url, 'openai.ts');
const { ModelError } = await loadTarget<typeof import('../solution/errors.ts')>(import.meta.url, 'errors.ts');

const question = [{ role: 'user' as const, content: '介绍一下杭州' }];
const longAnswer = '杭州是浙江省的省会，西湖、灵隐寺、龙井茶都很有名，也是很多互联网公司的所在地。';

describeMock('第 3 天：chatStream()（TODO 3）', () => {
  test('请求带上 stream: true 和 stream_options.include_usage', async () => {
    llm.reply({ content: '好的' });
    await chatStream({ messages: question });
    expect(llm.requests[0]).toMatchObject({ stream: true, stream_options: { include_usage: true } });
  });

  test('边生成边回调 onText，最后返回的结果和非流式调用一样', async () => {
    const script = { content: longAnswer, usage: { prompt_tokens: 10, completion_tokens: 30 } };
    llm.reply(script).reply(script);
    const pieces: string[] = [];
    const streamed = await chatStream({ messages: question }, { onText: (text) => pieces.push(text) });
    const whole = await chat({ messages: question });

    expect(pieces.length, '每收到一块文字就要回调一次 onText').toBeGreaterThan(5);
    expect(pieces.join('')).toBe(longAnswer);
    expect(streamed, '流式拼出来的结果，要和非流式的一样').toEqual(whole);
  });

  test('流式返回的工具调用，参数拼完整后是合法的 JSON', async () => {
    llm.reply({ toolCalls: [{ id: 'call_x', name: 'lookup_term', arguments: { term: '上下文窗口' } }] });
    const result = await chatStream({ messages: question });
    expect(result.finishReason).toBe('tool_calls');
    expect(JSON.parse(result.message.tool_calls![0].function.arguments)).toEqual({ term: '上下文窗口' });
  });

  test('思考内容通过 onReasoning 回调，并留在 message 里', async () => {
    llm.reply({ reasoning: '用户想了解杭州，简单介绍即可。', content: '杭州是浙江省会。' });
    const thinking: string[] = [];
    const result = await chatStream({ messages: question }, { onReasoning: (text) => thinking.push(text) });
    expect(thinking.join('')).toBe('用户想了解杭州，简单介绍即可。');
    expect(result.message.reasoning_content).toBe('用户想了解杭州，简单介绍即可。');
  });

  test('用 AbortSignal 中途取消：抛出 AbortError，已经收到的文字只是一部分', async () => {
    llm.reply({ content: longAnswer, chunkDelayMs: 20 });
    const controller = new AbortController();
    const pieces: string[] = [];
    const error = await chatStream(
      { messages: question },
      {
        signal: controller.signal,
        onText: (text) => {
          pieces.push(text);
          controller.abort(); // 收到第一段文字就取消
        },
      },
    ).catch((e: unknown) => e);

    expect((error as Error).name, '要把 signal 传给 fetch，取消后 fetch 会抛出 AbortError').toBe('AbortError');
    expect(pieces.join('').length).toBeLessThan(longAnswer.length);
  });

  test('接口返回错误时，和 chat() 一样抛出 ModelError', async () => {
    llm.fail({ status: 429, message: 'Rate limit reached' });
    const error = await chatStream({ messages: question }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModelError);
    expect((error as InstanceType<typeof ModelError>).status).toBe(429);
  });

  test('传到一半连接断了：要报错，不能把半截回复当成完整的', async () => {
    llm.reply({ content: longAnswer, disconnectAfter: 3 });
    await expect(chatStream({ messages: question })).rejects.toThrow();
  });
});

describeE2E('第 3 天：真实模型', () => {
  test('流式返回文字，拼起来就是完整的回答', async () => {
    const pieces: string[] = [];
    const result = await chatStream(
      { messages: [{ role: 'user', content: '用三句话介绍一下杭州。' }] },
      { onText: (text) => pieces.push(text) },
    );
    expect(pieces.length, '真实模型应该分好几块返回').toBeGreaterThan(1);
    expect(pieces.join('')).toBe(result.message.content);
    expect(result.usage.outputTokens, '加了 include_usage，最后应该能拿到用量').toBeGreaterThan(0);
  });

  test('流式返回的工具参数能拼成合法的 JSON', async () => {
    const tools = [
      {
        type: 'function' as const,
        function: {
          name: 'lookup_term',
          description: '在术语表里查一个术语的定义',
          parameters: { type: 'object', properties: { term: { type: 'string' } }, required: ['term'] },
        },
      },
    ];
    const result = await chatStream({
      messages: [
        { role: 'system', content: '用户问到任何术语，都先用 lookup_term 查术语表。' },
        { role: 'user', content: '「潮汐窗口」是什么意思？' },
      ],
      tools,
    });
    const call = result.message.tool_calls?.[0];
    expect(call?.function.name).toBe('lookup_term');
    expect(JSON.parse(call!.function.arguments).term).toContain('潮汐窗口');
  });
});
