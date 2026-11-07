// 第 28 天：Skills 与渐进式披露。
// 一个 skill 是一个目录，按 Agent Skills 开放标准（https://agentskills.io）组织：
//   vendor-comparison/
//     SKILL.md        开头是 YAML frontmatter（name、description），后面是给 Agent 看的做法说明
//     references/     需要时再读的参考资料
//     scripts/        可以运行的脚本（今天不运行，要等第 38 天有了沙箱）
// 渐进式披露：上下文里一开始只放每个 skill 的名字和一句话描述（几十个 token）；Agent 觉得用得上，
// 才用 load_skill 读全文；全文里提到的参考资料，用到时再用 read_skill_file 读。几十个 skill 也不会撑爆上下文。
// 第 28 天还有：项目根目录的 AGENTS.md，写给 Agent 看的项目说明，每次都放进 system prompt。
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { z } from 'zod';
import { defineTool, paginate, type Tool } from './tool.ts';
import { resolveInside } from './tools/files.ts';

export interface Skill {
  name: string;
  description: string;
  /** skill 的目录 */
  dir: string;
}

/**
 * 解析 SKILL.md 开头的 frontmatter：两行 --- 之间，每行一个「键: 值」。值两边的引号去掉。
 * 只支持单行的值，够 name 和 description 用了；完整的 YAML 要用专门的库。没有 frontmatter 返回 undefined
 */
export function parseFrontmatter(text: string): { data: Record<string, string>; body: string } | undefined {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return undefined;
  const data: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const pair = line.match(/^([\w-]+):\s*(.*)$/);
    if (!pair) continue;
    data[pair[1]] = pair[2].trim().replace(/^(["'])(.*)\1$/, '$2');
  }
  return { data, body: match[2].trim() };
}

/**
 * 按标准检查 name 和 description，返回发现的问题：
 * - name：1 到 64 个字符，只有小写字母、数字和连字符，不能以连字符开头或结尾，不能有连续的连字符，要和目录名一样
 * - description：1 到 1024 个字符。它是 Agent 决定用不用这个 skill 的唯一依据，要写清楚「做什么、什么时候用」
 */
export function validateSkill(data: Record<string, string>, dirName: string): string[] {
  const problems: string[] = [];
  const { name = '', description = '' } = data;
  if (!name) problems.push('缺少 name');
  else {
    if (name.length > 64) problems.push(`name 最多 64 个字符，现在有 ${name.length} 个`);
    if (!/^[a-z0-9-]+$/.test(name)) problems.push(`name 只能有小写字母、数字和连字符：${name}`);
    if (/^-|-$/.test(name)) problems.push(`name 不能以连字符开头或结尾：${name}`);
    if (name.includes('--')) problems.push(`name 不能有连续的连字符：${name}`);
    if (name !== dirName) problems.push(`name 要和目录名一样：name 是 ${name}，目录是 ${dirName}`);
  }
  if (!description) problems.push('缺少 description');
  else if (description.length > 1024) problems.push(`description 最多 1024 个字符，现在有 ${description.length} 个`);
  return problems;
}

export interface LoadedSkills {
  skills: Skill[];
  /** 没加载的 skill 和原因，比如「bad-skill：缺少 description」 */
  problems: string[];
}

/**
 * 从几个目录里找 skill：每个子目录里有 SKILL.md 的就是一个 skill。
 * 不合格的跳过并记下原因；名字重复的只留第一个（排在前面的目录优先，比如项目的 skill 优先于用户的）。
 * 目录不存在不算错。这里只读 frontmatter，不保留全文：全文要等 Agent 用到时再读
 */
export async function loadSkills(roots: string[]): Promise<LoadedSkills> {
  const skills: Skill[] = [];
  const problems: string[] = [];
  for (const root of roots) {
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      const dir = join(root, entry.name);
      const text = await readFile(join(dir, 'SKILL.md'), 'utf8').catch(() => undefined);
      if (text === undefined) continue;
      const parsed = parseFrontmatter(text);
      if (!parsed) {
        problems.push(`${entry.name}：SKILL.md 开头没有 frontmatter`);
        continue;
      }
      const found = validateSkill(parsed.data, entry.name);
      if (found.length) {
        problems.push(`${entry.name}：${found.join('；')}`);
        continue;
      }
      if (skills.some((s) => s.name === parsed.data.name)) {
        problems.push(`${entry.name}：和前面的 skill 重名，用前面那个`);
        continue;
      }
      skills.push({ name: parsed.data.name, description: parsed.data.description, dir });
    }
  }
  return { skills, problems };
}

/** 放进 system prompt 的 skill 目录：只有名字和描述，加上怎么用 */
export function formatSkillCatalog(skills: Skill[]): string {
  if (skills.length === 0) return '';
  const list = skills.map((s) => `- ${s.name}：${s.description}`).join('\n');
  return `# Skills
下面是可以用的 skill，每个是一套做某类事的方法。任务和某个 skill 的描述对得上时，先用 load_skill 读它的全文，再照着做；用不上就不要读。

${list}`;
}

/** 列出 skill 目录里的所有文件（不包括 SKILL.md），路径相对于 skill 的目录 */
async function listFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(current: string) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else files.push(relative(dir, path).split('\\').join('/'));
    }
  }
  await walk(dir);
  return files.filter((f) => f !== 'SKILL.md').sort();
}

/**
 * 两个工具：load_skill 读一个 skill 的全文（去掉 frontmatter），后面列出它带的文件；
 * read_skill_file 读 skill 目录里的一个文件，路径不能跑到目录外面
 */
export function createSkillTools(skills: Skill[], pageSize = 4000): Tool[] {
  const find = (name: string) => {
    const skill = skills.find((s) => s.name === name);
    if (!skill) throw new Error(`没有名为 ${name} 的 skill。可以用的：${skills.map((s) => s.name).join('、') || '（没有）'}`);
    return skill;
  };
  const loadSkill = defineTool({
    name: 'load_skill',
    description: '读一个 skill 的全文：做这类事的步骤和注意事项。名字来自 system prompt 里的 Skills 列表',
    schema: z.object({ name: z.string().describe('skill 的名字，比如 vendor-comparison') }),
    async execute({ name }) {
      const skill = find(name);
      const text = await readFile(join(skill.dir, 'SKILL.md'), 'utf8');
      const body = parseFrontmatter(text)?.body ?? text;
      const files = await listFiles(skill.dir);
      const extra = files.length ? `\n\n这个 skill 带的文件（用到时用 read_skill_file 读）：\n${files.map((f) => `- ${f}`).join('\n')}` : '';
      return `# skill：${skill.name}\n\n${body}${extra}`;
    },
  });
  const readSkillFile = defineTool({
    name: 'read_skill_file',
    description: '读一个 skill 目录里的文件，比如 references/ 下的参考资料、模板。先用 load_skill 看它带了哪些文件',
    schema: z.object({
      name: z.string().describe('skill 的名字'),
      path: z.string().describe('文件在 skill 目录里的路径，比如 references/template.md'),
      page: z.int().min(1).default(1).describe('读第几页，默认第 1 页'),
    }),
    async execute({ name, path, page }) {
      const skill = find(name);
      const full = resolveInside(skill.dir, path);
      const info = await stat(full).catch(() => undefined);
      if (!info?.isFile()) throw new Error(`${name} 里没有 ${path}。先用 load_skill 看它带了哪些文件`);
      return paginate(await readFile(full, 'utf8'), page, pageSize).content;
    },
  });
  return [loadSkill, readSkillFile];
}

/** 项目根目录的 AGENTS.md：写给 Agent 看的项目说明。没有就返回 undefined；太长的只保留前 maxChars 个字符 */
export async function loadAgentsMd(dir: string, maxChars = 8000): Promise<string | undefined> {
  const text = await readFile(join(dir, 'AGENTS.md'), 'utf8').catch(() => undefined);
  if (!text?.trim()) return undefined;
  const trimmed = text.trim();
  return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)}\n……（AGENTS.md 太长，只保留了前 ${maxChars} 个字符）` : trimmed;
}

/**
 * 组装 system prompt：基础的 prompt，加上 AGENTS.md 和 skill 目录。这几样在一次会话里都不变，放在 system prompt 里正好能命中缓存
 */
export function composeSystemPrompt(base: string, parts: { agentsMd?: string; skills?: Skill[] }): string {
  const sections = [base];
  if (parts.agentsMd) sections.push(`# 项目说明（来自 AGENTS.md）\n${parts.agentsMd}`);
  const catalog = formatSkillCatalog(parts.skills ?? []);
  if (catalog) sections.push(catalog);
  return sections.join('\n\n');
}
