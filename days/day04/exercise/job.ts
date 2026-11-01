// 要从招聘启事里提取的信息。用 zod 写一份 schema，同时得到三样东西：
// 交给模型的 JSON Schema、校验模型输出的规则、TypeScript 类型。
import { z } from 'zod';

// TODO 1：按下面的说明补全 schema。
// - title：字符串
// - company、city：字符串，可以是 null
// - salary：对象 { min, max, months }，可以是 null。min、max 是数字（单位千元），months 是整数
// - minYears：整数，可以是 null
// - education：只能是「不限」「大专」「本科」「硕士」「博士」之一（z.enum）
// - skills：字符串数组
// - remote：布尔值
// 「可以是 null」用 .nullable()，不要用 .optional()：严格模式要求每个字段都必须出现。
// 每个字段都用 .describe() 写上说明，模型靠它理解字段的含义和填法，可以参考 title 的写法。
// 最后用 .refine() 检查字段之间的关系：有薪资时，min 不能大于 max，错误挂在 ['salary', 'min'] 上。
export const JobPosting = z.object({
  title: z.string().describe('职位名称，比如「前端工程师」，不带城市和括号里的补充说明'),
});

/** 从 schema 推导出的类型，和 schema 永远保持一致 */
export type JobPosting = z.infer<typeof JobPosting>;
