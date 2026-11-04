// 测试用的文档目录：一个虚构产品「潮汐协议」的文档
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const DOCS: Record<string, string> = {
  'guide/deploy.md': `# 部署\n\n潮汐网关支持三种部署方式。\n\n## 用 Docker 部署\n\n运行 docker run -p 7443:7443 tide/gateway 启动网关。默认端口是 7443。\n\n## 上线前的检查\n\n上线之前要确认证书没有过期，并且在 #release 频道里通知值班的人。`,
  'guide/config.md': `# 配置\n\n配置文件叫 tide-config.yaml，放在 /etc/tide/ 下面。\n\n## 握手\n\nhandshake.retries 控制握手失败后的重试次数，默认 3 次。`,
  'faq.md': `# 常见问题\n\n## 为什么连接很慢\n\n多半是握手重试太多。把 handshake.retries 调小，或者检查网络。\n\n## 怎么退款\n\n潮汐协议是开源软件，不收费，也就没有退款。`,
  'notes.txt': '会议记录：下个版本把默认端口从 7443 改成 8443。',
  '.rag/ignored.md': '# 这个目录不该被索引',
  'image.png': 'not a doc',
};

export async function makeDocs(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'day17-docs-'));
  for (const [path, text] of Object.entries(DOCS)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  return root;
}
