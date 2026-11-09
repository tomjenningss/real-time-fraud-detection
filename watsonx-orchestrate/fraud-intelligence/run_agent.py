"""Backend adapter for one authenticated Fraud Intelligence invocation.

Reads the minimal investigation context as JSON from stdin and prints one JSON envelope to stdout.
It deliberately uses the already-authenticated ADK environment and never reads or emits credentials.
"""

from __future__ import annotations

import json
import sys
import time
from typing import Any

from ibm_watsonx_orchestrate.cli.commands.agents.agents_helper import get_agent_id_by_name
from ibm_watsonx_orchestrate.client.chat.run_client import RunClient
from ibm_watsonx_orchestrate.client.threads.threads_client import ThreadsClient
from ibm_watsonx_orchestrate.client.utils import instantiate_client


def _message_text(message: dict[str, Any]) -> str:
    content = message.get("content", "")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict) and item.get("response_type") == "text":
                parts.append(str(item.get("text", "")))
            elif isinstance(item, dict) and "text" in item:
                parts.append(str(item["text"]))
        return "\n".join(parts)
    return json.dumps(content)


def _find_evidence(value: Any) -> dict[str, Any] | None:
    if isinstance(value, str):
        candidate = value.strip()
        if candidate.startswith("```"):
            candidate = candidate.removeprefix("```json").removeprefix("```").removesuffix("```").strip()
        try:
            return _find_evidence(json.loads(candidate))
        except (json.JSONDecodeError, TypeError):
            return None
    if isinstance(value, list):
        for item in value:
            found = _find_evidence(item)
            if found is not None:
                return found
        return None
    if isinstance(value, dict):
        schema_version = value.get("schemaVersion")
        if schema_version in {
            "fraud-intelligence-evidence/1.1.0",
            "fraud-intelligence-evidence/1.2.0",
        }:
            return value
        for item in value.values():
            found = _find_evidence(item)
            if found is not None:
                return found
    return None


def _get_messages_with_retry(client: ThreadsClient, thread_id: str) -> Any:
    last_error: Exception | None = None
    for attempt in range(3):
        try:
            return client.get_thread_messages(thread_id)
        except Exception as error:
            last_error = error
            if attempt < 2:
                time.sleep(1 + attempt)
    assert last_error is not None
    raise last_error


def invoke(payload: dict[str, Any], timeout_seconds: int) -> dict[str, Any]:
    agent_id = get_agent_id_by_name("fraud_intelligence")
    run_client = instantiate_client(RunClient)
    threads_client = instantiate_client(ThreadsClient)
    started = time.monotonic()
    run = run_client.create_run(
        message=json.dumps(payload, sort_keys=True, separators=(",", ":")),
        agent_id=agent_id,
        capture_logs=False,
    )
    retries = max(1, timeout_seconds // 2)
    status = run_client.wait_for_run_completion(run["run_id"], poll_interval=2, max_retries=retries)
    if status.get("status", "").lower() != "completed":
        raise RuntimeError(f"Orchestrate run ended with status {status.get('status', 'unknown')}")
    messages = _get_messages_with_retry(threads_client, run["thread_id"])
    candidates = messages if isinstance(messages, list) else messages.get("data", [])
    evidence = _find_evidence(status)
    if evidence is None:
        for response in candidates:
            if isinstance(response, dict) and response.get("role") == "assistant":
                evidence = _find_evidence(response)
                if evidence is not None:
                    break
    if evidence is None:
        raise RuntimeError("Orchestrate run completed without schema-versioned evidence")
    return {
        "evidence": evidence,
        "latencyMs": round((time.monotonic() - started) * 1000),
        "threadId": run["thread_id"],
    }


def main() -> int:
    try:
        payload = json.load(sys.stdin)
        timeout_seconds = int(payload.pop("_timeoutSeconds", 45))
        print(json.dumps({"ok": True, **invoke(payload, timeout_seconds)}, separators=(",", ":")))
        return 0
    except Exception as error:
        print(json.dumps({"ok": False, "errorType": type(error).__name__}, separators=(",", ":")))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
