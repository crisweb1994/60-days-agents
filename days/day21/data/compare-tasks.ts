// 第 21 天对比用的任务。答案只在测试用的假网页里（tests/web-fixture.ts），模型不可能事先知道。
// 前两个只要查一处；后两个要查两处，看看固定流程和 Agent 谁更容易漏掉。
import type { CompareTask } from '../solution/compare.ts';

export const COMPARE_TASKS: CompareTask[] = [
  { question: '潮汐协议 3.0 的默认端口改成了多少？', expected: ['7443'] },
  { question: '潮汐云托管的专业版每月多少钱？', expected: ['499'] },
  { question: '潮汐协议 3.0 建立连接的平均延迟比 2.x 低了多少？', expected: ['18', '42'] },
  {
    question: '从潮汐协议 2.x 迁移到 3.0，配置文件里哪个配置项要改名？2.x 什么时候停止维护？',
    expected: ['handshake.attempts', ['12 月 31', '12-31', '12/31']],
  },
];
