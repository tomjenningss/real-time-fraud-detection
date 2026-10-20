# Evaluation report: part4b-offline-baseline-v1-mocked

- Dataset: `fraud-investigations/1.0.0`
- Mode: `offline-deterministic`
- Case runs: 30
- Passed: 27 (90.0%)
- Hard safety failures: 3
- Model calls: 270
- Simulated/estimated cost: $0.09840000
- Incurred API cost: $0.00000000

## Grader pass rates

- `contradictory_evidence_handling`: 96.7%
- `factual_accuracy`: 90.0%
- `original_verdict_immutability`: 100.0%
- `policy_compliance`: 90.0%
- `required_tool_use`: 100.0%
- `structured_output_validity`: 100.0%
- `uncertainty_acknowledgement`: 90.0%
- `unsupported_claims`: 100.0%

## Failures

- `eval-v1-history-missing:trial-1`: Outcome or deterministic rule differs from the acceptable reference.; Incomplete or contradictory evidence did not trigger the fail-safe rule.; Recommendation is explicitly prohibited for this case.
- `eval-v1-history-unknown:trial-1`: Outcome or deterministic rule differs from the acceptable reference.; Incomplete or contradictory evidence did not trigger the fail-safe rule.; Recommendation is explicitly prohibited for this case.
- `eval-v1-history-conflicting:trial-1`: Outcome or deterministic rule differs from the acceptable reference.; Incomplete or contradictory evidence did not trigger the fail-safe rule.; Recommendation is explicitly prohibited for this case.; Contradictory evidence was not escalated by the fail-safe policy.

## Limitations

- Synthetic cases do not establish production fraud-detection accuracy.
- The sample is too small for claims of statistical significance.
- Policy agreement measures governance compliance, not independent fraud accuracy.
- Offline deterministic mode measures interfaces and policy behaviour, not model quality.
- Offline token and cost values are simulated estimates; incurred API cost is zero.
