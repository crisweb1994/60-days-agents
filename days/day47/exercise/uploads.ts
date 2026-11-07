// 第 47 天：上传文件。三件事：
//   收：解析 multipart/form-data，边读边数字节，超过上限立刻停
//   验：不信文件名和 Content-Type，看文件开头的几个字节（魔数）判断真实类型，只收白名单里的
//   存：文件本身放进对象存储（这里是本地目录，线上是 S3、OSS、MinIO），键是「用户编号/内容的 sha256」；数据库里只存元数据
// 第 47 天的练习：TODO 1、5 在这里，TODO 2 在 pdf.ts，TODO 3 在 vision.ts，TODO 4 在 ingest.ts。检查：npm run check 47
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
  // TODO 1：按上面注释的四种魔数判断。startsWith(bytes, 字节数组, 偏移) 和 ascii(文字) 已经写好了
  void startsWith; void ascii;
  return bytes.length ? 'pdf' : undefined;
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
  // TODO 5：按上面注释实现：
  // - Content-Type 检查（415）；Content-Length 超过 maxBytes 直接 413
  // - Readable.toWeb(req) 接一个 TransformStream：累计字节数，超过 maxBytes 就 controller.error(new UploadError(413, …))
  // - new Request('http://localhost/upload', { method: 'POST', headers: { 'content-type': type }, body: 上面的流, duplex: 'half' }).formData()；
  //   出错时：是因为超了大小就 413，否则 400
  // - 取 file 字段（没有、或者是字符串：400）；读成 Uint8Array；sniffType 认不出来 415；超过这种类型的 MAX_BYTES 413
  // - 返回 { name: safeFileName(file.name), kind, bytes }
  void Readable; void MAX_BYTES; void maxBytes;
  throw new UploadError(501, `TODO 5：还没有实现 readUpload（${req.headers['content-type'] ?? ''}）`);
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
