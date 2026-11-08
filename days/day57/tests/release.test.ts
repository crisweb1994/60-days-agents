import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import { loadTarget } from '#testing';

const r = await loadTarget<typeof import('../solution/release.ts')>(import.meta.url, 'release.ts');
const { splitSections, checkReadme, parseCommits, nextVersion, renderChangelog, checkPackage } = r;

type Commit = import('../solution/release.ts').Commit;
const example = await readFile(new URL('../example/README.md', import.meta.url), 'utf8');
const template = await readFile(new URL('../templates/README.md', import.meta.url), 'utf8');
/** git log --format=%H%x1f%s%x1f%b%x1e 的输出 */
const log = (...commits: [string, string, string?][]) => commits.map(([hash, subject, body = '']) => `${hash}\x1f${subject}\x1f${body}\x1e\n`).join('');
const commit = (type: string, over: Partial<Commit> = {}): Commit => ({ hash: 'abc1234', type, description: `${type} 的说明`, breaking: false, ...over });

describe('第 57 天：README（TODO 1）', () => {
  test('splitSections：代码块里的 # 不算标题', () => {
    const sections = splitSections('前言\n# 标题\n一句话\n```bash\n# 注释\n```\n## 小节 ##\n内容');
    expect(sections.map((s) => [s.title, s.level])).toEqual([
      ['', 0],
      ['标题', 1],
      ['小节', 2],
    ]);
    expect(sections[1].body).toContain('# 注释');
  });

  test('示例项目没有问题；模板只差效果的数字（要你自己填）', () => {
    expect(checkReadme(example)).toEqual({ ok: true, problems: [] });
    expect(checkReadme(template).problems).toEqual(['「效果」里写出数字：在多少条用例上、达到了多少']);
  });

  test('缺了什么都按顺序说出来', () => {
    const md = ['## 项目', '', '## 安装', '', 'npm 装一下就行', '', '## Evaluation', '', '效果很好', '', '### 细节', '', '还是很好'].join('\n');
    expect(checkReadme(md).problems).toEqual([
      '第一行要是一级标题：# 项目名',
      '放一张截图或者演示动图：让人一眼看到它跑起来的样子',
      '「快速开始」里放一段能直接复制运行的命令',
      '缺少「配置」：要哪些 Key 和环境变量，哪些是可选的',
      '缺少「工作原理」：一张图或者几句话：它是怎么做到的',
      '「效果」里写出数字：在多少条用例上、达到了多少',
      '缺少「局限」：它做不好什么、不做什么',
      '缺少「数据与隐私」：数据会发给谁、存多久',
      '缺少「License」：用什么许可证',
    ]);
  });

  test('一句话介绍：要有，不能太长，图片不算；小节里的数字也算', () => {
    const tail = '\n\n![demo](a.png)\n\n## 快速开始\n\n```bash\nnpm start\n```\n\n## 配置\n\n## 工作原理\n\n## 效果\n\n### 细节\n\n召回 78%\n\n## 局限\n\n## 隐私\n\n## License\n';
    expect(checkReadme(`# x\n${tail}`).problems).toEqual(['一级标题下面要有一句话介绍']);
    expect(checkReadme(`# x\n\n${'很长'.repeat(61)}${tail}`).problems).toEqual(['一句话介绍太长了（122 字），控制在 120 字以内']);
    expect(checkReadme(`# x\n\n一句话。${tail}`).ok).toBe(true);
    expect(checkReadme(`# x\n\n一句话。${tail.replace('![demo](a.png)', '<video src="demo.mp4"></video>')}`).ok).toBe(true);
  });
});

describe('第 57 天：提交记录（TODO 2）', () => {
  test('约定式提交：类型、范围、!、BREAKING CHANGE；不是的算 other', () => {
    const commits = parseCommits(
      log(
        ['1111111aaaa', 'feat(review): 支持 REVIEW.md'],
        ['2222222bbbb', 'Fix: 行号差一'],
        ['3333333cccc', 'refactor!: 改了配置的名字'],
        ['4444444dddd', 'feat: 新的输出格式', '说明一下\nBREAKING CHANGE: 旧的格式不再支持'],
        ['5555555eeee', 'update readme'],
      ),
    );
    expect(commits).toEqual([
      { hash: '1111111', type: 'feat', scope: 'review', description: '支持 REVIEW.md', breaking: false },
      { hash: '2222222', type: 'fix', description: '行号差一', breaking: false },
      { hash: '3333333', type: 'refactor', description: '改了配置的名字', breaking: true },
      { hash: '4444444', type: 'feat', description: '新的输出格式', breaking: true },
      { hash: '5555555', type: 'other', description: 'update readme', breaking: false },
    ]);
    expect(parseCommits('')).toEqual([]);
  });
});

describe('第 57 天：版本号（TODO 3）', () => {
  test('1.x：不兼容 → 主版本；feat → 次版本；fix、perf → 修订号；后面的归零', () => {
    expect(nextVersion('1.2.3', [commit('fix'), commit('feat')])).toBe('1.3.0');
    expect(nextVersion('v1.2.3', [commit('perf')])).toBe('1.2.4');
    expect(nextVersion('1.2.3', [commit('chore', { breaking: true }), commit('fix')])).toBe('2.0.0');
    expect(nextVersion('1.2.3', [commit('docs'), commit('chore'), commit('other')]), '不用发版').toBeNull();
  });

  test('0.x：不兼容和 feat 都只加次版本；格式不对抛错', () => {
    expect(nextVersion('0.3.1', [commit('feat', { breaking: true })])).toBe('0.4.0');
    expect(nextVersion('0.3.1', [commit('feat')])).toBe('0.4.0');
    expect(nextVersion('0.3.1', [commit('fix')])).toBe('0.3.2');
    expect(() => nextVersion('1.2', [commit('fix')])).toThrow('版本号的格式不对');
  });
});

describe('第 57 天：更新日志（TODO 4）', () => {
  test('按组写；没有提交的组不写；docs 这些不写', () => {
    const commits = parseCommits(
      log(
        ['1111111aaaa', 'feat(review): 支持 REVIEW.md'],
        ['2222222bbbb', 'fix: 行号差一'],
        ['3333333cccc', 'refactor!: 改了配置的名字'],
        ['4444444dddd', 'docs: 补充 README'],
        ['5555555eeee', 'fix(webhook): 草稿 PR 不审'],
      ),
    );
    expect(renderChangelog('0.2.0', '2026-11-08', commits)).toBe(
      [
        '## 0.2.0（2026-11-08）',
        '',
        '### ⚠️ 不兼容的改动',
        '',
        '- 改了配置的名字（3333333）',
        '',
        '### 新功能',
        '',
        '- review：支持 REVIEW.md（1111111）',
        '',
        '### 修复',
        '',
        '- 行号差一（2222222）',
        '- webhook：草稿 PR 不审（5555555）',
        '',
      ].join('\n'),
    );
    expect(renderChangelog('1.0.1', '2026-11-08', [commit('perf', { description: '少调一次模型' })])).toBe('## 1.0.1（2026-11-08）\n\n### 性能\n\n- 少调一次模型（abc1234）\n');
  });
});

describe('第 57 天：package.json（TODO 5）', () => {
  test('能发布的没有问题', () => {
    const pkg = { name: '@acme/review-bot', version: '0.2.0', description: 'PR 审查机器人', license: 'MIT', repository: 'github:acme/review-bot', bin: { 'review-bot': 'dist/cli.js' }, files: ['dist'], engines: { node: '>=22.18' } };
    expect(checkPackage(pkg)).toEqual([]);
    expect(checkPackage({ ...pkg, bin: undefined, exports: './dist/index.js' })).toEqual([]);
  });

  test('按顺序报出问题', () => {
    expect(checkPackage({ private: true, name: 'Review Bot', version: '1.0' })).toEqual([
      'private 是 true，npm 不会发布它',
      'name 不是合法的包名',
      'version 要像 1.2.3',
      '缺少 description',
      '缺少 license',
      '缺少 repository',
      '要有 bin（命令行工具）或者 exports（库）',
      '用 files 列出要发布的文件，免得把测试、评估集、.env 发出去',
      '用 engines.node 写明要求的 Node.js 版本',
    ]);
  });
});
