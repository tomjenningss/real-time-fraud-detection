from pathlib import Path
import unittest


SCRIPT = Path(__file__).parents[1] / "run_glaramara_live_orchestrate.sh"
CHALLENGE = Path(__file__).parents[1] / "glaramara_phase_c_challenge.py"
CONFIGURE = Path(__file__).parents[1] / "configure_orchestrate.sh"


class GlaramaraLiveOrchestrateLauncherTests(unittest.TestCase):
    def test_launcher_is_localhost_only_and_selects_native_rest(self) -> None:
        source = SCRIPT.read_text()

        self.assertIn("--hostname 127.0.0.1", source)
        self.assertIn("FRAUD_INTELLIGENCE_PROVIDER=orchestrate", source)
        self.assertNotIn("watsonx-orchestrate/.venv/bin/python", source)
        self.assertNotIn("watsonx-orchestrate/fraud-intelligence/run_agent.py", source)
        self.assertNotIn("podman compose", source)
        self.assertNotIn("orchestrate env", source)

    def test_launcher_reads_private_runtime_values_without_printing_them(self) -> None:
        source = SCRIPT.read_text()

        self.assertIn("postgres_password=$(env_value POSTGRES_PASSWORD)", source)
        self.assertIn("session_secret=$(env_value GLARAMARA_SESSION_SECRET)", source)
        self.assertNotIn("echo \"$postgres_password\"", source)
        self.assertNotIn("echo \"$session_secret\"", source)

    def test_challenge_probe_is_bounded_and_requires_the_deterministic_authority(self) -> None:
        source = CHALLENGE.read_text()

        self.assertIn('default="http://127.0.0.1:13001"', source)
        self.assertIn('args.payment_count >= 5', source)
        self.assertIn('decision.get("source") == "deterministic_fast_path"', source)
        self.assertIn('decision.get("policyVersion") == "fast-path-policy/1.1.0"', source)
        self.assertIn('"fictional balance changed while creating the challenge"', source)

    def test_interactive_orchestrate_configuration_hides_the_api_key(self) -> None:
        source = CONFIGURE.read_text()

        self.assertIn("stty -echo", source)
        self.assertIn("FRAUD_INTELLIGENCE_PROVIDER=orchestrate", source)
        self.assertIn("WATSONX_ORCHESTRATE_API_KEY", source)
        self.assertNotIn('echo "$orchestrate_api_key"', source)


if __name__ == "__main__":
    unittest.main()
