// 用标准输入输出提供 fixtures/notes.ts 里的服务器：node days/day13/tests/fixtures/stdio-server.ts
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createNotesServer } from './notes.ts';

serveStdio(() => createNotesServer(process.env.NOTES_SERVER_NAME ?? 'team-notes'));
