// 第 14 天：用 stdio 部署笔记服务器。host 把它当作子进程启动：
// { "command": "node", "args": ["days/day14/solution/server/stdio.ts"], "env": { "NOTES_DIR": "/path/to/notes" } }
import { resolve } from 'node:path';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createNotesServer, log, notesRootFromEnv } from './notes.ts';

const root = resolve(notesRootFromEnv());
// 新老两种协议都接：老版本的 client 发来 initialize，照样服务
serveStdio(() => createNotesServer(root), { onerror: (error) => log(`出错了：${error.message}`) });
log(`已启动，笔记目录 ${root}`);
