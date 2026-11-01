import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { loadTarget } from '#testing';

const { JobPosting } = await loadTarget<typeof import('../solution/job.ts')>(import.meta.url, 'job.ts');

const valid = {
  title: '前端工程师',
  company: '潮汐科技',
  city: '杭州',
  salary: { min: 25, max: 40, months: 14 },
  minYears: 3,
  education: '本科',
  skills: ['TypeScript', 'React'],
  remote: true,
};

/** 校验失败时，出错的字段路径，比如 salary.min */
function failedPaths(value: unknown): string[] {
  const result = JobPosting.safeParse(value);
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'));
}

describe('第 4 天：用 zod 描述招聘启事（TODO 1）', () => {
  test('合法的数据能通过校验，每个字段都保留下来', () => {
    expect(failedPaths(valid)).toEqual([]);
    expect(JobPosting.parse(valid), 'zod 会丢掉 schema 里没声明的字段：八个字段都要写上').toEqual(valid);
  });

  test('city、company、salary、minYears 可以是 null', () => {
    const nulls = { ...valid, company: null, city: null, salary: null, minYears: null };
    expect(failedPaths(nulls)).toEqual([]);
    expect(JobPosting.parse(nulls)).toEqual(nulls);
  });

  test('类型不对的字段校验失败', () => {
    expect(failedPaths({ ...valid, title: 123 })).toContain('title');
    expect(failedPaths({ ...valid, skills: 'TypeScript' })).toContain('skills');
    expect(failedPaths({ ...valid, remote: '是' })).toContain('remote');
  });

  test('education 只能是规定的几个值', () => {
    expect(failedPaths({ ...valid, education: '高中' })).toContain('education');
  });

  test('薪资月数和工作年限必须是整数', () => {
    expect(failedPaths({ ...valid, salary: { min: 25, max: 40, months: 13.5 } })).toContain('salary.months');
    expect(failedPaths({ ...valid, minYears: 2.5 })).toContain('minYears');
  });

  test('月薪下限高于上限时校验失败，错误挂在 salary.min 上（用 refine）', () => {
    expect(failedPaths({ ...valid, salary: { min: 40, max: 25, months: 14 } })).toEqual(['salary.min']);
  });

  test('转成 JSON Schema 后，每个字段都是必填的，不允许多余的字段', () => {
    const schema = z.toJSONSchema(JobPosting) as { required: string[]; additionalProperties: boolean };
    expect(schema.required.sort(), '不要用 .optional()：可以没有的字段用 .nullable()').toEqual(
      ['city', 'company', 'education', 'minYears', 'remote', 'salary', 'skills', 'title'].sort(),
    );
    expect(schema.additionalProperties).toBe(false);
  });
});
