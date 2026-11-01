import { describe, expect, test } from 'vitest';
import { describeE2E, describeMock, loadTarget, setupModel } from '#testing';
import { samples } from '../samples.ts';

const llm = await setupModel();
const { extract, buildRequest, readOutput, parseJSON, ExtractError, TOOL_NAME } = await loadTarget<
  typeof import('../solution/extract.ts')
>(import.meta.url, 'extract.ts');
const { JobPosting } = await loadTarget<typeof import('../solution/job.ts')>(import.meta.url, 'job.ts');

const job = {
  title: '前端工程师',
  company: '潮汐科技',
  city: '杭州',
  salary: { min: 25, max: 40, months: 14 },
  minYears: 3,
  education: '本科',
  skills: ['TypeScript', 'React', 'Node.js'],
  remote: true,
};
const text = samples[0];

describe('第 4 天：三种做法的请求（TODO 2）', () => {
  test('JSON 模式：response_format 是 json_object，提示词里写明 JSON Schema', () => {
    const request = buildRequest(JobPosting, text, 'json_object');
    expect(request.responseFormat).toEqual({ type: 'json_object' });
    expect(request.tools, 'JSON 模式不需要工具').toBeUndefined();
    const prompt = request.messages.map((m) => ('content' in m ? m.content : '')).join('\n');
    expect(prompt, 'JSON 模式只保证输出是 JSON，字段要在提示词里说明：把 JSON Schema 写进去').toContain('"salary"');
    expect(request.messages.at(-1), '原文放在最后一条 user 消息里').toEqual({ role: 'user', content: text });
  });

  test('JSON Schema 约束：schema 交给 response_format，开启 strict', () => {
    const request = buildRequest(JobPosting, text, 'json_schema');
    expect(request.responseFormat).toMatchObject({ type: 'json_schema', json_schema: { strict: true } });
    const format = request.responseFormat as { json_schema: { name: string; schema: Record<string, unknown> } };
    expect(format.json_schema.name, 'json_schema 要有 name').toBeTruthy();
    expect(format.json_schema.schema).toMatchObject({ type: 'object', additionalProperties: false });
    expect(format.json_schema.schema, '去掉 $schema 字段').not.toHaveProperty('$schema');
  });

  test('工具调用：schema 写进工具的 parameters', () => {
    const request = buildRequest(JobPosting, text, 'tool');
    expect(request.responseFormat).toBeUndefined();
    expect(request.tools).toHaveLength(1);
    const tool = request.tools![0].function;
    expect(tool.name).toBe(TOOL_NAME);
    expect(tool.parameters).toMatchObject({ type: 'object', properties: { salary: {}, city: {} } });
    expect(tool.parameters, '去掉 $schema 字段').not.toHaveProperty('$schema');
  });
});

describe('第 4 天：读出模型的输出（TODO 3）', () => {
  test('工具调用的做法读工具参数，另外两种读 content', () => {
    const toolReply = {
      role: 'assistant' as const,
      content: null,
      tool_calls: [{ id: 'call_1', type: 'function' as const, function: { name: TOOL_NAME, arguments: '{"a":1}' } }],
    };
    expect(readOutput(toolReply, 'tool')).toBe('{"a":1}');
    expect(readOutput({ role: 'assistant', content: '{"b":2}' }, 'json_object')).toBe('{"b":2}');
    expect(readOutput({ role: 'assistant', content: '我不想调用工具' }, 'tool'), '没调用工具就是没有输出').toBeUndefined();
  });

  test('parseJSON 能去掉包在外面的 ```json 代码块', () => {
    expect(parseJSON('{"a":1}')).toEqual({ a: 1 });
    expect(parseJSON('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJSON('```\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(() => parseJSON('{"a":')).toThrow();
  });
});

describeMock('第 4 天：校验和自动修复（TODO 4、5）', () => {
  test('三种做法都能拿到通过校验的数据', async () => {
    llm.reply({ content: JSON.stringify(job) });
    expect((await extract(JobPosting, text, { mode: 'json_object' })).data).toEqual(job);
    llm.reply({ content: JSON.stringify(job) });
    expect((await extract(JobPosting, text, { mode: 'json_schema' })).data).toEqual(job);
    llm.reply({ toolCalls: [{ name: TOOL_NAME, arguments: job }] });
    const result = await extract(JobPosting, text, { mode: 'tool' });
    expect(result.data).toEqual(job);
    expect(result.attempts).toBe(1);
  });

  test('校验失败时，把错误交回模型，让它重新输出', async () => {
    const wrong = { ...job, salary: { min: 40, max: 25, months: 14 } };
    llm
      .reply({ content: JSON.stringify(wrong), usage: { prompt_tokens: 500, completion_tokens: 80 } })
      .reply({ content: JSON.stringify(job), usage: { prompt_tokens: 640, completion_tokens: 80 } });
    const result = await extract(JobPosting, text, { mode: 'json_object' });

    expect(result.data).toEqual(job);
    expect(result.attempts).toBe(2);
    expect(result.usage.inputTokens, '用量要把每一次调用都算上').toBe(1140);
    const [, retry] = llm.requests;
    expect(retry.messages.at(-2), '先把模型上一次的回复放回历史').toMatchObject({ role: 'assistant' });
    expect(retry.messages.at(-1), '再用一条 user 消息告诉它哪里不对').toMatchObject({ role: 'user' });
    expect(retry.messages.at(-1)?.content, '错误信息里要有 zod 给出的原因').toContain('月薪下限不能高于上限');
  });

  test('工具调用的做法里，错误要用 tool 消息交回，tool_call_id 和调用对上', async () => {
    llm
      .reply({ toolCalls: [{ id: 'call_bad', name: TOOL_NAME, arguments: { ...job, education: '高中' } }] })
      .reply({ toolCalls: [{ id: 'call_good', name: TOOL_NAME, arguments: job }] });
    const result = await extract(JobPosting, text, { mode: 'tool' });
    expect(result.data).toEqual(job);
    expect(llm.requests[1].messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'call_bad' });
    expect(llm.requests[1].messages.at(-1)?.content).toContain('education');
  });

  test('工具调用的做法里，模型没调用工具就提醒它调用', async () => {
    llm.reply({ content: '这个职位在杭州，月薪 25-40K。' }).reply({ toolCalls: [{ name: TOOL_NAME, arguments: job }] });
    const result = await extract(JobPosting, text, { mode: 'tool' });
    expect(result.attempts).toBe(2);
    expect(llm.requests[1].messages.at(-1)).toMatchObject({ role: 'user' });
    expect(llm.requests[1].messages.at(-1)?.content).toContain(TOOL_NAME);
  });

  test('输出不是合法的 JSON，或者是空白，也交回模型重来', async () => {
    llm
      .reply({ content: '{"title": "前端工程师", "salary": {"min": 25,' })
      .reply({ content: '   ' })
      .reply({ content: '```json\n' + JSON.stringify(job) + '\n```' });
    const result = await extract(JobPosting, text, { mode: 'json_object' });
    expect(result.attempts).toBe(3);
    expect(llm.requests[1].messages.at(-1)?.content, '告诉模型输出不是合法的 JSON').toContain('JSON');
  });

  test('调用 maxAttempts 次还不行，就抛出 ExtractError', async () => {
    const wrong = JSON.stringify({ ...job, remote: '可以远程' });
    llm.reply({ content: wrong }).reply({ content: wrong });
    const error = await extract(JobPosting, text, { mode: 'json_object', maxAttempts: 2 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExtractError);
    expect((error as Error).message, '错误信息里带上最后一次的问题').toContain('remote');
    expect(llm.requests, '最多调用 maxAttempts 次模型').toHaveLength(2);
  });
});

describeE2E('第 4 天：真实模型', () => {
  for (const mode of ['json_object', 'tool'] as const) {
    test(`${mode}：从杂乱的招聘启事里提取出薪资和城市`, async () => {
      const { data } = await extract(JobPosting, text, { mode });
      expect(data.city).toContain('杭州');
      expect(data.salary).toEqual({ min: 25, max: 40, months: 14 });
      expect(data.education).toBe('本科');
    });
  }
});
