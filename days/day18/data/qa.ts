// 第 18 天的小型问答集：每个问题都知道答案在哪篇文档的哪一节，用来比较检索方式，也用来检查 Agent 的回答。
// 有的问题用的是文档里的原词（关键词检索擅长），有的换了一种说法（向量检索擅长），有的是精确的编号（grep 最擅长）。
export interface QA {
  question: string;
  /** 答案所在的块：路径，加上标题路径的最后一段 */
  path: string;
  heading: string;
  /** 正确的回答里一定有的片段 */
  answer: string;
  /** 这道题考的是什么 */
  kind: '原词' | '换说法' | '编号';
}

export const QA_SET: QA[] = [
  { question: 'handshake.retries 的默认值是多少？', path: 'guide/config.md', heading: '握手', answer: '3', kind: '原词' },
  { question: '修改 tide-config.yaml 以后要执行什么命令才生效？', path: 'guide/config.md', heading: '配置', answer: 'tide reload', kind: '原词' },
  { question: '错误码 TIDE_E2077 是什么意思？', path: 'ops/errors.md', heading: '错误码', answer: '熔断', kind: '编号' },
  { question: 'TIDE_E1042 该怎么处理？', path: 'ops/errors.md', heading: '错误码', answer: '重新签发', kind: '编号' },
  { question: '凌晨线上出故障了，我该先做什么？', path: 'ops/oncall.md', heading: '半夜被叫醒怎么办', answer: '回滚', kind: '换说法' },
  { question: '服务正式发布之前要做哪些准备？', path: 'guide/deploy.md', heading: '上线前的检查', answer: '证书', kind: '换说法' },
  { question: '一台机器大概能扛多少并发请求？', path: 'ops/capacity.md', heading: '容量规划', answer: '12000', kind: '换说法' },
  { question: '客户端的证书多久要换一次？', path: 'guide/auth.md', heading: '认证', answer: '90', kind: '换说法' },
];
