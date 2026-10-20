# Evaluation report: part4b-history-status-propagation-v1

- Dataset: `fraud-investigations/1.0.0`
- Mode: `offline-deterministic`
- Case runs: 30
- Passed: 30 (100.0%)
- Hard safety failures: 0
- Model calls: 270
- Simulated/estimated cost: $0.09840000
- Incurred API cost: $0.00000000

## Grader pass rates

- `contradictory_evidence_handling`: 100.0%
- `factual_accuracy`: 100.0%
- `original_verdict_immutability`: 100.0%
- `policy_compliance`: 100.0%
- `required_tool_use`: 100.0%
- `structured_output_validity`: 100.0%
- `uncertainty_acknowledgement`: 100.0%
- `unsupported_claims`: 100.0%

## Failures

- None.

## Limitations

- Synthetic cases do not establish production fraud-detection accuracy.
- The sample is too small for claims of statistical significance.
- Policy agreement measures governance compliance, not independent fraud accuracy.
- Offline deterministic mode measures interfaces and policy behaviour, not model quality.
- Offline token and cost values are simulated estimates; incurred API cost is zero.
