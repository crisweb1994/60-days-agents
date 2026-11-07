// 第 29 天：主动向用户澄清。问题含糊（「帮我查一下那个协议」是哪个协议？）、或者要用户做决定时，与其猜，不如问。
// 命令行里直接问（context.ask）；后台运行、没人可问时，抛出中断，Agent 暂停，等用户回答以后再接着跑。
import { z } from 'zod';
import { defineTool, InterruptSignal } from '../tool.ts';

export const askUser = defineTool({
  name: 'ask_user',
  description:
    '问用户一个问题，等他回答。只在问题含糊、不问就会做错，或者要用户做决定时用；能自己查到的不要问。' +
    '一次只问一个问题；给出几个选项，用户回答起来更快',
  schema: z.object({
    question: z.string().min(1).describe('要问的问题，一句话'),
    options: z.array(z.string()).max(5).optional().describe('可以选的答案，最多 5 个。用户也可以不选，直接回答'),
  }),
  async execute({ question, options }, context) {
    if (context.ask) {
      const answer = (await context.ask(question, options)).trim();
      return answer ? `用户回答：${answer}` : '用户没有回答。按你最合理的理解接着做，并在回答里说明你的假设';
    }
    if (context.pausable) throw new InterruptSignal({ kind: 'input', question, options });
    throw new Error('现在没法问用户。按你最合理的理解接着做，并在回答里说明你的假设');
  },
});
