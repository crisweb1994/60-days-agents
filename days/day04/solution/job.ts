// 要从招聘启事里提取的信息。用 zod 写一份 schema，同时得到三样东西：
// 交给模型的 JSON Schema、校验模型输出的规则、TypeScript 类型。
import { z } from 'zod';

export const JobPosting = z
  .object({
    title: z.string().describe('职位名称，比如「前端工程师」，不带城市和括号里的补充说明'),
    company: z.string().nullable().describe('公司名称；没写就填 null'),
    city: z.string().nullable().describe('工作城市，只写城市名，比如「杭州」；没写就填 null'),
    salary: z
      .object({
        min: z.number().describe('月薪下限，单位是千元，比如 25K 填 25'),
        max: z.number().describe('月薪上限，单位是千元'),
        months: z.number().int().describe('一年发几个月工资，比如 14 薪填 14；没写就填 12'),
      })
      .nullable()
      .describe('薪资；面议或没写就填 null'),
    minYears: z.number().int().nullable().describe('至少要几年工作经验；不限或没写就填 null'),
    education: z.enum(['不限', '大专', '本科', '硕士', '博士']).describe('最低学历要求；没写就填「不限」'),
    skills: z.array(z.string()).describe('要求或加分的技能，比如 TypeScript、React'),
    remote: z.boolean().describe('能不能远程办公，部分时间远程也算'),
  })
  // JSON Schema 表达不了「下限不高于上限」这种字段之间的关系，用 refine 在校验时检查
  .refine((job) => !job.salary || job.salary.min <= job.salary.max, {
    message: '月薪下限不能高于上限',
    path: ['salary', 'min'],
  });

/** 从 schema 推导出的类型，和 schema 永远保持一致 */
export type JobPosting = z.infer<typeof JobPosting>;
