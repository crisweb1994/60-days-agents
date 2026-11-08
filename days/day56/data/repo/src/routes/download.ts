import { readFile } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { requireUser } from '../auth.ts';

const UPLOAD_DIR = '/var/data/uploads';

export async function download(req: IncomingMessage, name: string) {
  requireUser(req);
  return readFile(join(UPLOAD_DIR, name));
}
