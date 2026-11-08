// 第 47 天：上传文件。三件事：
//   收：解析 multipart/form-data，边读边数字节，超过上限立刻停
//   验：不信文件名和 Content-Type，看文件开头的几个字节（魔数）判断真实类型，只收白名单里的
//   存：文件本身放进对象存储（这里是本地目录，线上是 S3、OSS、MinIO），键是「用户编号/内容的 sha256」；数据库里只存元数据
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { dirname, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';

export type FileKind = 'pdf' | 'png' | 'jpeg' | 'webp';

export const MIME: Record<FileKind, string> = { pdf: 'application/pdf', png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };

/** 每种类型最大多少字节。图片交给视觉模型，太大了既慢又贵，多数接口也有上限 */
export const MAX_BYTES: Record<FileKind, number> = { pdf: 20 * 1024 * 1024, png: 5 * 1024 * 1024, jpeg: 5 * 1024 * 1024, webp: 5 * 1024 * 1024 };

const startsWith = (bytes: Uint8Array, signature: number[], offset = 0) => signature.every((b, i) => bytes[offset + i] === b);
const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));

/**
 * 看文件开头判断类型（魔数）：
 * - PDF：%PDF-
 * - PNG：89 50 4E 47 0D 0A 1A 0A
 * - JPEG：FF D8 FF
 * - WebP：RIFF，第 8 到 11 个字节是 WEBP
 * 都不是返回 undefined。文件名叫 a.pdf、Content-Type 写 application/pdf，都不算数：它们是上传的人随便写的
 */
export function sniffType(bytes: Uint8Array): FileKind | undefined {
  if (startsWith(bytes, ascii('%PDF-'))) return 'pdf';
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8)) return 'webp';
  return undefined;
}

/** 文件名只留下最后一段，去掉路径、控制字符和引号，最长 120 个字符。它只用来显示和下载时的建议文件名 */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[\u0000-\u001f\u007f"<>|*?:]/g, '').trim().slice(0, 120);
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : 'file';
}

export class UploadError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'UploadError';
    this.status = status;
  }
}

export interface Upload {
  name: string;
  kind: FileKind;
  bytes: Uint8Array;
}

/**
 * 从 multipart/form-data 的请求里取出名为 file 的文件：
 * - Content-Type 不是 multipart/form-data：415
 * - 边读边数，总字节数超过 maxBytes：413（Content-Length 已经超了就不用读）
 * - 没有 file 字段、或者它不是文件：400
 * - sniffType 认不出来：415；认出来了但超过这种类型的上限：413
 * 解析用 Web 标准的 Request.formData()（Node 自带的 undici 实现了它），不用第三方库
 */
export async function readUpload(req: IncomingMessage, maxBytes = 20 * 1024 * 1024): Promise<Upload> {
  const type = req.headers['content-type'] ?? '';
  if (!/^multipart\/form-data\b/i.test(type)) throw new UploadError(415, '请用 multipart/form-data 上传，文件放在 file 字段');
  if (Number(req.headers['content-length']) > maxBytes) throw new UploadError(413, `文件太大了，最多 ${Math.round(maxBytes / 1024 / 1024)}MB`);
  let size = 0;
  const limited = Readable.toWeb(req).pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        size += chunk.byteLength;
        if (size > maxBytes) controller.error(new UploadError(413, `文件太大了，最多 ${Math.round(maxBytes / 1024 / 1024)}MB`));
        else controller.enqueue(chunk);
      },
    }),
  );
  let form: FormData;
  try {
    form = await new Request('http://localhost/upload', { method: 'POST', headers: { 'content-type': type }, body: limited as ReadableStream, duplex: 'half' } as RequestInit).formData();
  } catch (error) {
    if (size > maxBytes) throw new UploadError(413, `文件太大了，最多 ${Math.round(maxBytes / 1024 / 1024)}MB`);
    throw new UploadError(400, `请求体解析不了：${(error as Error).message}`);
  }
  const file = form.get('file');
  if (!file || typeof file === 'string') throw new UploadError(400, '没有找到文件：文件要放在 file 字段');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const kind = sniffType(bytes);
  if (!kind) throw new UploadError(415, '只支持 PDF、PNG、JPEG、WebP');
  if (bytes.byteLength > MAX_BYTES[kind]) throw new UploadError(413, `${kind.toUpperCase()} 最大 ${MAX_BYTES[kind] / 1024 / 1024}MB`);
  return { name: safeFileName(file.name), kind, bytes };
}

// ---------- 对象存储 ----------

export interface ObjectStore {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
}

/** 对象的键：用户编号/内容的 sha256。同一个用户传两次同样的文件只存一份；不同用户的文件在不同的前缀下 */
export function objectKey(userId: string, bytes: Uint8Array): string {
  return `${userId}/${createHash('sha256').update(bytes).digest('hex')}`;
}

/**
 * 本地目录当对象存储，开发和测试用。键里只允许字母、数字、- _ . /，解析以后必须还在 root 里面（防住 ../）。
 * 线上换成 S3 兼容的存储：接口一样，下载时可以发一个几分钟就过期的预签名网址，文件不经过你的服务器
 */
export function createFsObjectStore(root: string): ObjectStore {
  const path = (key: string) => {
    if (!/^[\w./-]+$/.test(key)) throw new Error(`对象的键不合法：${key}`);
    const full = resolve(root, key);
    if (!full.startsWith(resolve(root) + sep)) throw new Error(`对象的键不合法：${key}`);
    return full;
  };
  return {
    async put(key, bytes) {
      await mkdir(dirname(path(key)), { recursive: true });
      await writeFile(path(key), bytes);
    },
    async get(key) {
      return new Uint8Array(await readFile(path(key)));
    },
    async delete(key) {
      await rm(path(key), { force: true });
    },
  };
}
