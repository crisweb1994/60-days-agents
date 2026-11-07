// 计算器：最简单的工具，也是其他工具的写法示范。
import { z } from 'zod';
import { defineTool } from '../tool.ts';
import { evaluate } from './math.ts';

export const calculator = defineTool({
  name: 'calculator',
  description: '计算一个数学算式，支持 + - * / % ^ 和括号。需要精确计算时一定要用它，不要心算',
  schema: z.object({
    expression: z.string().describe('要计算的算式，比如 (1234 + 56) * 7.8'),
  }),
  execute: ({ expression }) => String(evaluate(expression)),
});
