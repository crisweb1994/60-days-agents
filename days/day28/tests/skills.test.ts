import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { describeE2E, describeMock, loadTarget, setupModel } from '#testing';
import { makeSetup } from './helpers.ts';
import { startFixture } from './web-fixture.ts';

const llm = await setupModel();
const fixture = await startFixture();
const sk = await loadTarget<typeof import('../solution/skills.ts')>(import.meta.url, 'skills.ts');
const { parseFrontmatter, validateSkill, loadSkills, formatSkillCatalog, createSkillTools, loadAgentsMd, composeSystemPrompt } = sk;
const { runToolCall } = await loadTarget<typeof import('../solution/tool.ts')>(import.meta.url, 'tool.ts');
const { research } = await loadTarget<typeof import('../solution/research.ts')>(import.meta.url, 'research.ts');
const { createModel } = await loadTarget<typeof import('../solution/providers.ts')>(import.meta.url, 'providers.ts');

/** 课程自带的两个 skill */
const COURSE_SKILLS = fileURLToPath(new URL('../skills', import.meta.url));
const call = (name: string, args: object) => ({ id: 'c', type: 'function' as const, function: { name, arguments: JSON.stringify(args) } });

async function skillDir(skills: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'day28-skills-'));
  for (const [dir, text] of Object.entries(skills)) {
    await mkdir(join(root, dir), { recursive: true });
    await writeFile(join(root, dir, 'SKILL.md'), text);
  }
  return root;
}
const skillMd = (name: string, description: string, body = '正文') => `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;

describe('第 28 天：解析和检查 SKILL.md（TODO 1）', () => {
  test('parseFrontmatter：键值、去掉引号、正文', () => {
    expect(parseFrontmatter('---\nname: fact-check\ndescription: "核实一个说法"\nlicense: MIT\n---\n\n# 标题\n正文\n')).toEqual({
      data: { name: 'fact-check', description: '核实一个说法', license: 'MIT' },
      body: '# 标题\n正文',
    });
    expect(parseFrontmatter('# 没有 frontmatter')).toBeUndefined();
  });

  test('validateSkill：合格的没有问题', () => {
    expect(validateSkill({ name: 'pdf-tools-2', description: '处理 PDF' }, 'pdf-tools-2')).toEqual([]);
  });

  test('validateSkill：name 的各种问题', () => {
    expect(validateSkill({ description: 'x' }, 'a')).toEqual(['缺少 name']);
    expect(validateSkill({ name: 'PDF_Tools', description: 'x' }, 'PDF_Tools')).toEqual(['name 只能有小写字母、数字和连字符：PDF_Tools']);
    expect(validateSkill({ name: '-pdf', description: 'x' }, '-pdf')).toEqual(['name 不能以连字符开头或结尾：-pdf']);
    expect(validateSkill({ name: 'pdf--tools', description: 'x' }, 'pdf--tools')).toEqual(['name 不能有连续的连字符：pdf--tools']);
    expect(validateSkill({ name: 'pdf', description: 'x' }, 'pdf-tools')).toEqual(['name 要和目录名一样：name 是 pdf，目录是 pdf-tools']);
    const long = 'a'.repeat(65);
    expect(validateSkill({ name: long, description: 'x' }, long)).toEqual(['name 最多 64 个字符，现在有 65 个']);
  });

  test('validateSkill：description 不能没有，也不能太长', () => {
    expect(validateSkill({ name: 'a' }, 'a')).toEqual(['缺少 description']);
    expect(validateSkill({ name: 'a', description: '字'.repeat(1025) }, 'a')).toEqual(['description 最多 1024 个字符，现在有 1025 个']);
  });
});

describe('第 28 天：加载 skill（TODO 2）', () => {
  test('课程自带的两个 skill 都合格', async () => {
    const { skills, problems } = await loadSkills([COURSE_SKILLS]);
    expect(problems).toEqual([]);
    expect(skills.map((s) => s.name)).toEqual(['fact-check', 'vendor-comparison']);
    expect(skills[1].description).toContain('对比');
  });

  test('不合格的跳过并说明原因；重名的留前面目录的；没有 SKILL.md 的目录和不存在的目录都不算错', async () => {
    const project = await skillDir({ 'fact-check': skillMd('fact-check', '项目自己的核实方法'), 'Bad Skill': skillMd('Bad Skill', 'x'), notes: '' });
    await writeFile(join(project, 'notes', 'SKILL.md'), '没有 frontmatter');
    await mkdir(join(project, 'empty'));
    const { skills, problems } = await loadSkills([project, COURSE_SKILLS, '/no/such/dir']);
    expect(skills.map((s) => [s.name, s.description.slice(0, 6)])).toEqual([
      ['fact-check', '项目自己的核'],
      ['vendor-comparison', '对比几家产品'],
    ]);
    expect(problems).toEqual([
      'Bad Skill：name 只能有小写字母、数字和连字符：Bad Skill',
      'notes：SKILL.md 开头没有 frontmatter',
      'fact-check：和前面的 skill 重名，用前面那个',
    ]);
  });

  test('目录里只有名字和描述', async () => {
    const { skills } = await loadSkills([COURSE_SKILLS]);
    const catalog = formatSkillCatalog(skills);
    expect(catalog).toContain('- fact-check：核实一个具体的说法');
    expect(catalog, '全文要等用到时再读').not.toContain('找原始出处');
    expect(formatSkillCatalog([])).toBe('');
  });
});

describe('第 28 天：读 skill 的工具（TODO 3）', () => {
  test('load_skill：全文（去掉 frontmatter），后面列出它带的文件', async () => {
    const { skills } = await loadSkills([COURSE_SKILLS]);
    const tools = createSkillTools(skills);
    const result = await runToolCall(tools, call('load_skill', { name: 'vendor-comparison' }));
    expect(result.content.startsWith('# skill：vendor-comparison\n\n# 对比调研')).toBe(true);
    expect(result.content).not.toContain('description:');
    expect(result.content.endsWith('这个 skill 带的文件（用到时用 read_skill_file 读）：\n- references/report-template.md')).toBe(true);
  });

  test('read_skill_file：读 skill 目录里的文件；不能跑到目录外面', async () => {
    const { skills } = await loadSkills([COURSE_SKILLS]);
    const tools = createSkillTools(skills);
    const template = await runToolCall(tools, call('read_skill_file', { name: 'vendor-comparison', path: 'references/report-template.md' }));
    expect(template.content).toContain('# 对比报告的模板');
    const escape = await runToolCall(tools, call('read_skill_file', { name: 'vendor-comparison', path: '../fact-check/SKILL.md' }));
    expect(escape.isError).toBe(true);
    const missing = await runToolCall(tools, call('read_skill_file', { name: 'fact-check', path: 'scripts/run.sh' }));
    expect(missing.content).toContain('fact-check 里没有 scripts/run.sh');
    const unknown = await runToolCall(tools, call('load_skill', { name: 'pdf' }));
    expect(unknown.content).toContain('没有名为 pdf 的 skill。可以用的：fact-check、vendor-comparison');
  });
});

describe('AGENTS.md 和 system prompt', () => {
  test('有 AGENTS.md 就放进 system prompt，后面是 skill 目录', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'day28-agents-'));
    expect(await loadAgentsMd(dir)).toBeUndefined();
    await writeFile(join(dir, 'AGENTS.md'), '# 项目\n回答一律用简体中文。\n');
    const agentsMd = await loadAgentsMd(dir);
    const { skills } = await loadSkills([COURSE_SKILLS]);
    const prompt = composeSystemPrompt('基础的 prompt', { agentsMd, skills });
    expect(prompt.startsWith('基础的 prompt\n\n# 项目说明（来自 AGENTS.md）\n# 项目\n回答一律用简体中文。\n\n# Skills')).toBe(true);
    expect(composeSystemPrompt('基础的 prompt', {})).toBe('基础的 prompt');
  });
});

describeMock('第 28 天：研究助手按需读 skill', () => {
  test('先读 skill 全文，再按它的要求读模板', async () => {
    const setup = await makeSetup(import.meta.url, fixture);
    const { skills } = await loadSkills([COURSE_SKILLS]);
    llm
      .reply({ toolCalls: [{ name: 'load_skill', arguments: { name: 'vendor-comparison' } }] })
      .reply({ toolCalls: [{ name: 'read_skill_file', arguments: { name: 'vendor-comparison', path: 'references/report-template.md' } }] })
      .reply({ content: '## 结论\n……' });
    await research('对比一下潮汐云托管的基础版和专业版', { ...setup, skills }, { model: createModel('openai') });
    expect(llm.requests[0].tools!.map((t) => t.function.name)).toContain('load_skill');
    expect(llm.requests[1].messages.at(-1)!.content).toContain('只用一手资料');
    expect(llm.requests[2].messages.at(-1)!.content).toContain('## 对比表');
  });
});

describeE2E('第 28 天：真实模型会不会用 skill', () => {
  test('对比类的问题：读 vendor-comparison；闲聊：不读', { timeout: 300_000 }, async () => {
    const setup = await makeSetup(import.meta.url, fixture);
    const { skills } = await loadSkills([COURSE_SKILLS]);
    const { RESEARCH_PROMPT } = await loadTarget<typeof import('../solution/prompts.ts')>(import.meta.url, 'prompts.ts');
    const { runAgent } = await loadTarget<typeof import('../solution/agent.ts')>(import.meta.url, 'agent.ts');
    const { createResearchTools } = await loadTarget<typeof import('../solution/research.ts')>(import.meta.url, 'research.ts');
    const { tools } = createResearchTools({ ...setup, skills });
    const system = composeSystemPrompt(RESEARCH_PROMPT, { skills });
    const used = async (question: string) => {
      const result = await runAgent(question, { model: createModel('openai'), tools, system, maxSteps: 12 });
      return result.messages.flatMap((m) => (m.role === 'assistant' ? (m.tool_calls ?? []) : [])).map((c) => `${c.function.name} ${c.function.arguments}`);
    };
    const compare = await used('对比一下潮汐云托管的基础版和专业版，我该选哪个？');
    console.log(compare.join('\n'));
    expect(compare.some((c) => c.startsWith('load_skill') && c.includes('vendor-comparison'))).toBe(true);
    const hello = await used('你好');
    expect(hello.some((c) => c.startsWith('load_skill'))).toBe(false);
  });
});
