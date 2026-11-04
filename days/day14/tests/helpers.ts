import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** 建一个临时的笔记目录。long.md 有 5000 多个字符，要分三次才能读完 */
export async function makeNotes(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'day14-notes-'));
  const files: Record<string, string> = {
    'work/release.md': '# 发布流程\n\n每周四下午三点发布。发布前在 #release 频道里说一声。\n',
    'work/oncall.md': '# 值班表\n\n十一月的值班负责人是蓝鲸组的老周。发布当天值班的人要在线。\n',
    'life/recipes.md': '# 菜谱\n\n番茄炒蛋：先炒蛋，再炒番茄。\n',
    'long.md': `# 长笔记\n\n${Array.from({ length: 120 }, (_, i) => `第 ${i + 1} 行：${'记录'.repeat(18)}`).join('\n')}\n结尾：暗号是青柠。\n`,
    'draft.txt': '不是 Markdown，不算笔记',
  };
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  return root;
}
