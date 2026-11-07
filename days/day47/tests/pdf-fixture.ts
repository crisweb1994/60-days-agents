// 测试用的 PDF：手写一个最小的 PDF 文件（每页几行文字，用内置的 Helvetica 字体，所以只能写英文和数字）。
// 空数组的页什么都不写，用来模拟扫描件。
export function makePdf(pages: string[][]): Uint8Array {
  const objects: string[] = [];
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  pages.forEach((lines, i) => {
    const escape = (s: string) => s.replace(/([\\()])/g, '\\$1');
    const stream = lines.length ? `BT /F1 12 Tf 72 720 Td 16 TL ${lines.map((l) => `(${escape(l)}) Tj T*`).join(' ')} ET` : '';
    objects[4 + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`;
    objects[5 + i * 2] = `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`;
  });
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let i = 1; i < objects.length; i++) {
    offsets[i] = Buffer.byteLength(out, 'latin1');
    out += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n${offsets.slice(1).map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, 'latin1'));
}

/** 潮汐协议 3.0 的发布说明：第 1 页概述，第 2 页端口和一张表，第 3 页是空的（扫描件） */
export const RELEASE_PDF = () =>
  makePdf([
    ['Tide Protocol 3.0 Release Notes', 'Overview: the handshake now takes one round trip.'],
    ['Ports', 'The default port of Tide 3.0 is 7443.', 'Port | Protocol | Note', '7443 | tide | default', '7444 | admin | internal'],
    [],
  ]);

/** 一张「PNG」：只有文件头是真的，视觉模型由 mock 回答，用不到真的像素 */
export const FAKE_PNG = () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, ...new Array(32).fill(1)]);
