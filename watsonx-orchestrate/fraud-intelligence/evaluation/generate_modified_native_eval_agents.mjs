#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const source = await readFile(path.join(HERE, "../agent.yaml"), "utf8");
const output = path.join(HERE, "temporary-native-agents-20261106");
const agents = [
  ["native_eval_gemma_20261106", "Modified Native Gemma", "bedrock-mantle/google.gemma-4-31b"],
  ["native_eval_groq_20261106", "Modified Native Groq", "groq/openai/gpt-oss-120b"],
  ["native_eval_frontier_20261106", "Modified Native Frontier", "watsonx-orchestrate/frontier"],
];

await mkdir(output, { recursive: true });
for (const [name, label, model] of agents) {
  const yaml = source
    .replace(/^name: fraud_intelligence$/m, `name: ${name}`)
    .replace(/^display_name: Fraud Intelligence$/m, `display_name: Fraud Intelligence ${label}`)
    .replace(/^llm: .*$/m, `llm: ${model}`);
  if (yaml === source) throw new Error("Canonical agent substitutions were not applied");
  await writeFile(path.join(output, `${name}.yaml`), yaml);
}
process.stdout.write(`Generated ${agents.length} isolated evaluation agent definitions in ${output}\n`);
