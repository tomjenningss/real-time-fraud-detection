import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import ts from "typescript";

const sourceUrl = new URL("../lib/fraud-intelligence/ibm-iam.ts", import.meta.url);
const compiled = ts.transpileModule(readFileSync(sourceUrl, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { IbmIamTokenProvider, withOneIamRetry } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`
);

function tokenResponse(accessToken, expiresIn = 3600) {
  return new Response(JSON.stringify({ access_token: accessToken, expires_in: expiresIn }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

test("IAM uses the required form body and refreshes five minutes before expiry", async () => {
  const previousKey = process.env.WATSONX_ORCHESTRATE_API_KEY;
  process.env.WATSONX_ORCHESTRATE_API_KEY = "test-api-key";
  let now = 0;
  const calls = [];
  const provider = new IbmIamTokenProvider(async (url, init) => {
    calls.push({ url, init });
    return tokenResponse(`token-${calls.length}`, 600);
  }, () => now);
  try {
    assert.equal(await provider.getToken(), "token-1");
    now = 299_999;
    assert.equal(await provider.getToken(), "token-1");
    now = 300_000;
    assert.equal(await provider.getToken(), "token-2");
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, "https://iam.cloud.ibm.com/identity/token");
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.headers["Content-Type"], "application/x-www-form-urlencoded");
    assert.equal(calls[0].init.body.get("grant_type"), "urn:ibm:params:oauth:grant-type:apikey");
    assert.equal(calls[0].init.body.get("apikey"), "test-api-key");
  } finally {
    if (previousKey === undefined) delete process.env.WATSONX_ORCHESTRATE_API_KEY;
    else process.env.WATSONX_ORCHESTRATE_API_KEY = previousKey;
  }
});

test("IAM deduplicates concurrent token refreshes", async () => {
  const previousKey = process.env.WATSONX_ORCHESTRATE_API_KEY;
  process.env.WATSONX_ORCHESTRATE_API_KEY = "test-api-key";
  let calls = 0;
  const provider = new IbmIamTokenProvider(async () => {
    calls += 1;
    await new Promise((resolve) => setImmediate(resolve));
    return tokenResponse("shared-token");
  }, () => 0);
  try {
    assert.deepEqual(await Promise.all(Array.from({ length: 8 }, () => provider.getToken())),
      Array(8).fill("shared-token"));
    assert.equal(calls, 1);
  } finally {
    if (previousKey === undefined) delete process.env.WATSONX_ORCHESTRATE_API_KEY;
    else process.env.WATSONX_ORCHESTRATE_API_KEY = previousKey;
  }
});

test("a 401 invalidates IAM state and retries exactly once", async () => {
  const previousKey = process.env.WATSONX_ORCHESTRATE_API_KEY;
  process.env.WATSONX_ORCHESTRATE_API_KEY = "test-api-key";
  let tokenCalls = 0;
  const requestTokens = [];
  const provider = new IbmIamTokenProvider(async () => tokenResponse(`token-${++tokenCalls}`), () => 0);
  try {
    const response = await withOneIamRetry(provider, async (token) => {
      requestTokens.push(token);
      return { status: 401 };
    });
    assert.equal(response.status, 401);
    assert.deepEqual(requestTokens, ["token-1", "token-2"]);
    assert.equal(tokenCalls, 2);
    provider.invalidate("token-1");
    assert.equal(await provider.getToken(), "token-2", "a stale 401 must not invalidate a newer token");
    assert.equal(tokenCalls, 2);
  } finally {
    if (previousKey === undefined) delete process.env.WATSONX_ORCHESTRATE_API_KEY;
    else process.env.WATSONX_ORCHESTRATE_API_KEY = previousKey;
  }
});
