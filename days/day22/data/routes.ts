// 第 22 天：路由器的评估集。每个问题标好了应该走哪条路，用来算分类的准确率。
// chat：不用查资料；docs：我们自己的潮汐网关，要查内部文档（data/docs/）；research：要上网查。
// 有几个故意放在边界上：同样提到「潮汐」，问的是我们的部署还是协议的新版本，走的路不一样。
import type { Route } from '../solution/router.ts';

export interface RouteCase {
  question: string;
  route: Route;
}

export const ROUTE_CASES: RouteCase[] = [
  { question: '你好，你能做什么？', route: 'chat' },
  { question: '把「上线前要检查证书」翻译成英文', route: 'chat' },
  { question: '帮我把这句话改得礼貌一点：明天之前把报告交上来', route: 'chat' },
  { question: '12 乘以 37 等于多少？', route: 'chat' },
  { question: 'TCP 的三次握手是什么意思？', route: 'chat' },
  { question: '给值班同事写一句鼓励的话', route: 'chat' },
  { question: '什么是灰度发布？用一句话解释', route: 'chat' },
  { question: '谢谢，今天就到这里', route: 'chat' },

  { question: '我们的网关修改配置以后要执行什么命令才生效？', route: 'docs' },
  { question: '错误码 TIDE_E2077 是什么意思？', route: 'docs' },
  { question: '半夜线上出故障了，按我们的值班手册应该先做什么？', route: 'docs' },
  { question: '我们的网关上线之前要检查什么？', route: 'docs' },
  { question: '我们一台网关实例大概能扛多少请求？', route: 'docs' },
  { question: '内部签发的客户端证书有效期多久？', route: 'docs' },
  { question: '按我们的文档，handshake.retries 默认是几次？', route: 'docs' },
  { question: '回滚到上一个版本的命令是什么？我们的手册里怎么写的', route: 'docs' },

  { question: '潮汐协议 3.0 是什么时候发布的？', route: 'research' },
  { question: '潮汐协议 3.0 比 2.x 快了多少？', route: 'research' },
  { question: '潮汐云托管的专业版现在多少钱？', route: 'research' },
  { question: '潮汐协议 2.x 什么时候停止维护？', route: 'research' },
  { question: '对比一下 Tavily、博查、Brave 三家搜索 API 的价格', route: 'research' },
  { question: 'MCP 最新的规范版本是哪一个？有什么变化？', route: 'research' },
  { question: '今年有哪些新发布的开源 embedding 模型？', route: 'research' },
  { question: '潮汐协议 3.0 的默认端口改成了多少？网上的发布说明怎么说', route: 'research' },
];
