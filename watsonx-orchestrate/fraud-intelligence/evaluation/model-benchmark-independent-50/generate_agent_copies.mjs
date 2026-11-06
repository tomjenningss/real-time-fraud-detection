#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const source = await readFile(path.join(HERE, "../../agent.yaml"), "utf8");
const agents = [
  ["independent_50_gemma_20261105", "Gemma", "bedrock-mantle/google.gemma-4-31b"],
  ["independent_50_groq_20261105", "Groq", "groq/openai/gpt-oss-120b"],
];
await mkdir(path.join(HERE, "temporary-agents"), { recursive: true });
for (const [name, label, model] of agents) {
  const yaml = source
    .replace(/^name: fraud_intelligence$/m, `name: ${name}`)
    .replace(/^display_name: Fraud Intelligence$/m, `display_name: Fraud Intelligence Independent 50 ${label}`)
    .replace(/^llm: .*$/m, `llm: ${model}`);
  await writeFile(path.join(HERE, "temporary-agents", `${name}.yaml`), yaml);
}
