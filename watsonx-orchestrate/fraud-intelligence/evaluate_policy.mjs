import { reassessFraudEvidence } from "../../glaramara-bank/lib/fraud-intelligence/policy.mjs";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
process.stdout.write(JSON.stringify(reassessFraudEvidence(payload)));
