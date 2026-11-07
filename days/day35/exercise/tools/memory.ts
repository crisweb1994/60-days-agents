// 第 19 天：记忆工具。什么时候记、记什么，由模型判断；system prompt 里写清楚规则（prompts.ts）。
import { z } from 'zod';
import { MEMORY_TYPES, type MemoryStore } from '../memory.ts';
import { defineTool, type Tool } from '../tool.ts';

export function createMemoryTools(store: MemoryStore): Tool[] {
  const remember = defineTool({
    name: 'remember',
    description:
      '把以后的对话也用得到的信息记下来：用户的偏好、纠正过的做法、项目的背景、资源的位置。' +
      '同名的记忆会被更新，所以改一条记忆就用它原来的名字。不要记一次性的、能从文件或网上重新查到的、敏感的信息',
    schema: z.object({
      name: z.string().describe('短横线连接的英文名字，比如 prefers-short-answers、report-deadline'),
      type: z.enum(MEMORY_TYPES).describe('user：用户的情况和偏好；feedback：用户纠正过的做法；project：项目的背景和约束；reference：资源的位置'),
      content: z.string().describe('要记的内容，一两句话。日期写成绝对日期（2026-11-06），不要写「下周五」'),
      ttl_days: z.int().min(1).optional().describe('多少天以后忘掉。只在一段时间内有用的信息才填，比如这周的安排'),
    }),
    risk: 'write',
    async execute({ name, type, content, ttl_days }) {
      const { updated } = await store.remember({ name, type, content, ttlDays: ttl_days });
      return `${updated ? '已更新' : '已记下'}记忆 ${name}`;
    },
  });

  const forget = defineTool({
    name: 'forget',
    description: '忘掉一条记忆。用户说某件事不对了、不用再记了，或者要求忘掉时用',
    schema: z.object({ name: z.string().describe('记忆的名字') }),
    risk: 'write',
    async execute({ name }) {
      return (await store.forget(name)) ? `已忘掉 ${name}` : `没有名为 ${name} 的记忆。用 recall 看看有哪些`;
    },
  });

  const recall = defineTool({
    name: 'recall',
    description: '按关键词查找记忆，返回名字、类型和内容。关键词留空就列出全部',
    schema: z.object({ query: z.string().describe('关键词，多个用空格分开；留空列出全部') }),
    async execute({ query }) {
      const memories = query.trim() ? await store.search(query) : await store.list();
      if (memories.length === 0) return query.trim() ? `没有和「${query}」相关的记忆` : '还没有任何记忆';
      return memories.map((m) => `- ${m.name}（${m.type}，更新于 ${m.updated.slice(0, 10)}）：${m.content}`).join('\n');
    },
  });

  return [remember, forget, recall];
}
