// 第 57 天：发版前检查一遍，算出下一个版本号和更新日志，打印出发布的命令。
// 运行：node days/day57/exercise/cli.ts [项目目录]
// 它不会替你发布：打 tag、推送、npm publish、GitHub Release 都是不可逆的，命令打印出来，你看过再执行。
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { checkPackage, checkReadme, GIT_LOG_FORMAT, nextVersion, parseCommits, renderChangelog } from './release.ts';

const root = process.argv[2] ?? '.';
const git = async (...args: string[]) => (await promisify(execFile)('git', args, { cwd: root, maxBuffer: 64 * 1024 * 1024 })).stdout;
let failed = false;

const readme = await readFile(join(root, 'README.md'), 'utf8').catch(() => '');
const r = checkReadme(readme);
console.log(r.ok ? '✅ README 没有问题' : `README：\n${r.problems.map((p) => `  - ${p}`).join('\n')}`);
failed ||= !r.ok;

let pkg: Record<string, any> | undefined;
try {
  pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
} catch {
  console.log('（没有 package.json，跳过 npm 的检查）');
}
const publishToNpm = pkg && pkg.private !== true;
if (pkg && publishToNpm) {
  const problems = checkPackage(pkg);
  console.log(problems.length ? `package.json：\n${problems.map((p) => `  - ${p}`).join('\n')}` : '✅ package.json 没有问题');
  failed ||= problems.length > 0;
}

const lastTag = (await git('describe', '--tags', '--abbrev=0').catch(() => '')).trim();
const commits = parseCommits(await git('log', ...(lastTag ? [`${lastTag}..HEAD`] : []), `--format=${GIT_LOG_FORMAT}`));
const current = lastTag || pkg?.version || '0.0.0';
const version = nextVersion(current, commits);
console.log(`\n上一个版本 ${current}，之后有 ${commits.length} 个提交（约定式提交 ${commits.filter((c) => c.type !== 'other').length} 个）`);
if (!version) {
  console.log('没有 feat、fix、perf 或者不兼容的改动，不用发版');
  process.exit(failed ? 1 : 0);
}
const notes = renderChangelog(version, new Date().toISOString().slice(0, 10), commits);
console.log(`下一个版本：${version}\n\n${notes}`);
if (failed) {
  console.log('先把上面的问题解决了再发布');
  process.exit(1);
}
console.log(`发布的步骤（看过再执行）：
  1. 把上面的更新日志加到 CHANGELOG.md 的最前面${pkg ? `\n  2. npm version ${version} --no-git-tag-version` : ''}
  3. git commit -am "chore: release v${version}"
  4. git tag v${version} && git push --follow-tags${publishToNpm ? '\n  5. npm publish --provenance --access public   # 在 CI 里发更好：有来源证明，令牌不落在本机' : ''}
  6. gh release create v${version} --notes-file 这一版的更新日志.md`);
