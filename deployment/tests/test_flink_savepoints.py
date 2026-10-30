from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


REPO_DIR = Path(__file__).resolve().parents[2]
JAVA_ID = "a" * 32
SQL_ID = "b" * 32


class FlinkSavepointTests(unittest.TestCase):
    def run_savepoints(
        self, ids_mode: str = "crlf", fail_job: str = ""
    ) -> tuple[subprocess.CompletedProcess, Path, str]:
        temp_dir = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, temp_dir)
        deployment = temp_dir / "deployment"
        runtime = temp_dir / ".runtime"
        deployment.mkdir()
        runtime.mkdir()
        script = deployment / "save_flink_state.sh"
        shutil.copy2(REPO_DIR / "deployment" / "save_flink_state.sh", script)
        script.chmod(0o755)
        (deployment / "common.sh").write_text(
            "repo_dir=$(CDPATH= cd -- \"$(dirname -- \"$0\")/..\" && pwd)\n"
            "compose() {\n"
            "  printf '%s\\n' \"$*\" >>\"$COMMAND_LOG\"\n"
            "  case \" $* \" in\n"
            "    *' /flink-scripts/flink_jobs.py ids '*)\n"
            "      printf '>>>> provider notice <<<<\\r\\n'\n"
            "      case \"$IDS_MODE\" in\n"
            f"        crlf) printf 'java={JAVA_ID}\\r\\nsql={SQL_ID}\\r\\n' ;;\n"
            f"        missing) printf 'java={JAVA_ID}\\r\\n'; return 1 ;;\n"
            "      esac\n"
            "      ;;\n"
            "    *' /opt/flink/bin/flink savepoint '*)\n"
            "      job_id=$6\n"
            "      if [ \"$FAIL_JOB\" = \"$job_id\" ]; then\n"
            "        echo 'underlying Flink error' >&2\n"
            "        return 7\n"
            "      fi\n"
            f"      case \"$job_id\" in {JAVA_ID}) suffix=java ;; {SQL_ID}) suffix=sql ;; *) return 8 ;; esac\n"
            "      printf 'Savepoint completed. Path: file:///checkpoints/savepoints/savepoint-%s\\r\\n' \"$suffix\"\n"
            "      ;;\n"
            "    *' jobmanager test -d '*'savepoint-'*) return 0 ;;\n"
            "  esac\n"
            "}\n"
        )
        command_log = temp_dir / "commands.log"
        environment = os.environ.copy()
        environment["COMMAND_LOG"] = str(command_log)
        environment["IDS_MODE"] = ids_mode
        environment["FAIL_JOB"] = fail_job

        result = subprocess.run(
            [str(script)],
            cwd=temp_dir,
            env=environment,
            text=True,
            capture_output=True,
            check=False,
        )
        commands = command_log.read_text() if command_log.exists() else ""
        return result, runtime, commands

    def test_crlf_and_provider_output_produce_two_verified_savepoints(self) -> None:
        result, runtime, commands = self.run_savepoints()

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f"flink savepoint {JAVA_ID}", commands)
        self.assertIn(f"flink savepoint {SQL_ID}", commands)
        manifest = (runtime / "flink-savepoints.env").read_text()
        self.assertIn("JAVA_SAVEPOINT=file:///checkpoints/savepoints/savepoint-java", manifest)
        self.assertIn("SQL_SAVEPOINT=file:///checkpoints/savepoints/savepoint-sql", manifest)
        self.assertIn("Verified savepoint: Per-transaction behavioural enrichment", result.stderr)
        self.assertIn("Verified savepoint: Fraud SQL signals analytics", result.stderr)

    def test_missing_required_job_fails_before_any_savepoint(self) -> None:
        result, runtime, commands = self.run_savepoints(ids_mode="missing")

        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("flink savepoint", commands)
        self.assertFalse((runtime / "flink-savepoints.env").exists())

    def test_underlying_savepoint_failure_is_reported_without_manifest(self) -> None:
        result, runtime, _ = self.run_savepoints(fail_job=SQL_ID)

        self.assertEqual(result.returncode, 7)
        self.assertIn("Fraud SQL signals analytics", result.stderr)
        self.assertIn("underlying Flink error", result.stderr)
        self.assertFalse((runtime / "flink-savepoints.env").exists())


if __name__ == "__main__":
    unittest.main()
