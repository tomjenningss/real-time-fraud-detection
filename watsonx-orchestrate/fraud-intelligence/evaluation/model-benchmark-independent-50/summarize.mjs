#!/usr/bin/env node

import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { reassessFraudEvidence } from "../../../../glaramara-bank/lib/fraud-intelligence/policy.mjs";
import { buildFraudPreventionGuidance } from "../../../../glaramara-bank/lib/fraud-intelligence/guidance.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const suite = JSON.parse(await readFile(path.join(HERE, "scenarios.json"), "utf8"));
const scenarios = new Map(suite.scenarios.map((item) => [item.id, item]));
const topKeys = ["beneficiaryRelationship","clarificationQuestion","contradictions","missingEvidence",
  "paymentPurpose","paymentRecognition","provenance","scamIndicators","schemaVersion","thirdPartyInfluence",
  "uncertainty","verificationClaims"];

function percentile(values, p) { const sorted = [...values].sort((a,b) => a-b); return sorted[Math.ceil(sorted.length*p)-1] ?? null; }
function same(a,b) { return JSON.stringify([...a].sort()) === JSON.stringify([...b].sort()); }
function schemaValid(e) { return e && e.schemaVersion === "fraud-intelligence-evidence/1.1.0"
  && same(Object.keys(e), topKeys) && ["verificationClaims","scamIndicators","contradictions","missingEvidence","provenance"].every((k) => Array.isArray(e[k])); }
function grade(s,e) {
  if (!schemaValid(e)) return { exact:false, factPreserved:false, contradiction:false, uncertainty:false, unsupportedClaims:0 };
  const x=s.expectedEvidence; const answers=s.answers;
  const core=["paymentRecognition","beneficiaryRelationship","paymentPurpose","thirdPartyInfluence"];
  const factPreserved=core.every((k)=>e[k]===x[k]);
  const indicators=same(e.scamIndicators,x.requiredIndicators);
  const claims=same(e.verificationClaims,x.verificationClaims);
  const contradiction=e.contradictions.length>=x.minimumContradictions;
  const uncertainty=e.uncertainty===x.uncertainty;
  const ids=new Set(e.provenance.map((p)=>p?.findingId));
  const provenance=x.requiredProvenance.every((id)=>ids.has(id)) && e.provenance.every((p)=>Array.isArray(p?.sources)
    && p.sources.length && p.sources.every((src)=>typeof answers[src.questionId]==="string" && answers[src.questionId].includes(src.excerpt)));
  const unsupportedClaims=e.verificationClaims.filter((v)=>!x.verificationClaims.includes(v)).length;
  return { exact:factPreserved&&indicators&&claims&&contradiction&&uncertainty&&provenance,
    factPreserved, contradiction, uncertainty, indicators, claims, provenance, unsupportedClaims };
}
function semantic(e) { if (!e) return null; return JSON.stringify({ paymentRecognition:e.paymentRecognition,
  beneficiaryRelationship:e.beneficiaryRelationship,paymentPurpose:e.paymentPurpose,thirdPartyInfluence:e.thirdPartyInfluence,
  verificationClaims:[...(e.verificationClaims??[])].sort(),scamIndicators:[...(e.scamIndicators??[])].sort(),
  contradictions:(e.contradictions??[]).map((c)=>[...(c.sourceQuestionIds??[])].sort()).sort(),uncertainty:e.uncertainty,
  missingEvidence:[...(e.missingEvidence??[])].sort() }); }

async function model(slug) {
  const dir=path.join(HERE,"raw",slug); const names=(await readdir(dir)).filter((n)=>n.endsWith(".json")&&n!=="manifest.json");
  const records=[]; for(const n of names) records.push(JSON.parse(await readFile(path.join(dir,n),"utf8")));
  records.sort((a,b)=>a.scenarioId.localeCompare(b.scenarioId)||a.run-b.run);
  let tp=0,fp=0,fn=0,unsupportedClaims=0,policyPass=0,guidancePass=0,fact=0,contradiction=0,uncertainty=0,exactInv=0;
  const primary={}; const failures=[]; const latencies=[];
  for(const r of records){ const s=scenarios.get(r.scenarioId); const g=grade(s,r.evidence); if(r.latencyMs)latencies.push(r.latencyMs);
    if(g.exact)exactInv++; if(g.factPreserved)fact++; if(g.contradiction)contradiction++; if(g.uncertainty)uncertainty++; unsupportedClaims+=g.unsupportedClaims;
    const exp=new Set(s.expectedEvidence.requiredIndicators.filter((v)=>v!=="NONE")); const act=new Set((r.evidence?.scamIndicators??[]).filter((v)=>v!=="NONE"));
    for(const v of act)exp.has(v)?tp++:fp++; for(const v of exp)if(!act.has(v))fn++;
    try{const p=reassessFraudEvidence(r.evidence);if(p.outcome===s.expectedPolicy.outcome&&p.policyTrace?.[0]?.ruleId===s.expectedPolicy.ruleId)policyPass++;
      const guidance=buildFraudPreventionGuidance({evidence:r.evidence,reassessment:p,customerExplanation:s.answers.payment_circumstances,context:s.payment});
      const rendered=[guidance.rendered.heading,guidance.rendered.context,...guidance.rendered.steps,guidance.rendered.paymentStatus,guidance.rendered.simulationNotice].join("\n").toLowerCase();
      if(guidance.category===s.expectedGuidance.category&&s.expectedGuidance.requiredText.every((t)=>rendered.includes(t.toLowerCase()))
        &&s.expectedGuidance.forbiddenText.every((t)=>!rendered.includes(t.toLowerCase())))guidancePass++;}catch{}
    if(r.run===1){primary[r.scenarioId]=g.exact;if(!g.exact)failures.push({scenarioId:r.scenarioId,category:s.category,
      differences:Object.entries(g).filter(([k,v])=>k!=="exact"&&v===false).map(([k])=>k)});}
  }
  const repeated={}; for(const s of suite.scenarios){const rs=records.filter((r)=>r.scenarioId===s.id);if(rs.length===3)repeated[s.id]={
    exact:new Set(rs.map((r)=>JSON.stringify(r.evidence))).size===1,semantic:new Set(rs.map((r)=>semantic(r.evidence))).size===1,
    passes:rs.map((r)=>grade(s,r.evidence).exact)};}
  const primaryPass=Object.values(primary).filter(Boolean).length; const ambiguous=suite.scenarios.filter((s)=>s.category==="ambiguous");
  return {model:records.find((r)=>r.model)?.model,plannedInvocations:records.length,schemaValid:records.filter((r)=>schemaValid(r.evidence)).length,
    apiFailures:records.filter((r)=>r.executionError).length,primaryExact:{pass:primaryPass,total:50},invocationExact:{pass:exactInv,total:records.length},
    indicators:{tp,fp,fn,precision:tp/(tp+fp),recall:tp/(tp+fn)},factPreservation:{pass:fact,total:records.length},
    contradictionDetection:{pass:contradiction,total:records.length},uncertaintyDetection:{pass:uncertainty,total:records.length},
    reassessment:{pass:policyPass,total:records.length},guidance:{pass:guidancePass,total:records.length},unsupportedVerificationClaims:unsupportedClaims,
    latencyMs:{mean:Math.round(latencies.reduce((a,b)=>a+b,0)/latencies.length),median:percentile(latencies,.5),p95:percentile(latencies,.95)},
    ambiguousCaution:{pass:ambiguous.filter((s)=>primary[s.id]).length,total:ambiguous.length},repeatConsistency:{semantic:Object.values(repeated).filter((v)=>v.semantic).length,total:Object.keys(repeated).length,scenarios:repeated},
    primary,failures};
}

const gemma=await model("gemma"),groq=await model("groq");
const paired={bothPassed:[],onlyGemma:[],onlyGroq:[],bothFailed:[]};
for(const s of suite.scenarios){const g=gemma.primary[s.id],q=groq.primary[s.id];paired[g&&q?"bothPassed":g?"onlyGemma":q?"onlyGroq":"bothFailed"].push(s.id);}
const report={generatedAt:new Date().toISOString(),suiteVersion:suite.suiteVersion,gemma,groq,paired,
  previousBenchmark:{gemma:{original:[28,30],heldout:[16,18]},groq:{original:[21,30],heldout:[16,18]}}};
await writeFile(path.join(HERE,"comparison-summary.json"),JSON.stringify(report,null,2)+"\n");
console.log(JSON.stringify(report,null,2));
