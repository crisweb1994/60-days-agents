// 第 33 天：模型横评。同一个评估集，分别用 .env 里的主模型（OPENAI_*）和第二家模型（ALT_*）跑，比较效果、成本和延迟。
// 运行（需真实模型）：node days/day33/exercise/eval/bakeoff.ts --tags web,docs
try {
  process.loadEnvFile();
} catch {
  // 没有 .env 文件时，就用终端里已经设置的环境变量
}
const { readFile } = await import('node:fs/promises');
const { parseArgs } = await import('node:util');
const { createAltModel, createModel, providerFromEnv } = await import('../providers.ts');
const { parsePrice } = await import('../usage.ts');
const { parseDataset, selectCases } = await import('./dataset.ts');
const { DATASET_FILE, startEvalEnv } = await import('./env.ts');
const { citationGrader, factsGrader, trajectoryGrader } = await import('./graders.ts');
const { bakeoff, formatBakeoff } = await import('./regression.ts');
const { evaluate } = await import('./ci.ts');
const { researchTarget } = await import('./run.ts');

const { values } = parseArgs({ options: { tags: { type: 'string' }, limit: { type: 'string' } } });
const alt = createAltModel();
if (!alt) {
  console.error('要先在 .env 里配置第二家模型：ALT_MODEL，以及 ALT_BASE_URL、ALT_API_KEY（和主模型同一家时可以不填）');
  process.exit(1);
}
const text = await readFile(DATASET_FILE, 'utf8');
const cases = selectCases(parseDataset(text), { tags: values.tags?.split(','), limit: values.limit ? Number(values.limit) : undefined });
const env = await startEvalEnv();
const models = [createModel(providerFromEnv()), alt];
const records = [];
for (const model of models) {
  console.error(`· ${model.name}：${cases.length} 条用例`);
  records.push(await evaluate(cases, researchTarget(() => env.makeSetup(), model), { name: model.name, model, datasetText: text, graders: [factsGrader, citationGrader, trajectoryGrader] }));
}
await env.close();
console.log(formatBakeoff(bakeoff(records, { [models[0].name]: parsePrice(process.env.OPENAI_PRICE), [alt.name]: parsePrice(process.env.ALT_PRICE) })));
