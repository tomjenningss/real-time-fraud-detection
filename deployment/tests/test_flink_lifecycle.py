from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


REPO_DIR = Path(__file__).resolve().parents[2]


class FlinkLifecycleTests(unittest.TestCase):
    def run_lifecycle(
        self, plan: str, savepoints: tuple[str, str] | None = None
    ) -> tuple[str, dict[str, str], Path]:
        temp_dir = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, temp_dir)
        deployment = temp_dir / "deployment"
        runtime = temp_dir / ".runtime"
        deployment.mkdir()
        runtime.mkdir()
        script = deployment / "ensure_flink_jobs.sh"
        shutil.copy2(REPO_DIR / "deployment" / "ensure_flink_jobs.sh", script)
        script.chmod(0o755)
        (deployment / "common.sh").write_text(
            "repo_dir=$(CDPATH= cd -- \"$(dirname -- \"$0\")/..\" && pwd)\n"
            "project=lifecycle-test\n"
            "compose() {\n"
            "  printf '%s\\n' \"$*\" >>\"$COMMAND_LOG\"\n"
            "  case \" $* \" in\n"
            "    *' /flink-scripts/flink_jobs.py plan '*)\n"
            "      case \"$FAKE_PLAN\" in\n"
            "        both) printf 'java\\nsql\\n' ;;\n"
            "        provider-crlf)\n"
            "          printf '>>>> Executing external compose provider podman-compose. <<<<\\r\\n\\r\\n'\n"
            "          printf 'java\\r\\nsql\\r\\n'\n"
            "          ;;\n"
            "        none) : ;;\n"
            "      esac\n"
            "      ;;\n"
            "    *' /flink-scripts/flink_jobs.py check '*) return 0 ;;\n"
            "  esac\n"
            "  return 0\n"
            "}\n"
        )
        if savepoints:
            (runtime / "flink-savepoints.env").write_text(
                f"JAVA_SAVEPOINT={savepoints[0]}\nSQL_SAVEPOINT={savepoints[1]}\n"
            )
        command_log = temp_dir / "commands.log"
        environment = os.environ.copy()
        environment["COMMAND_LOG"] = str(command_log)
        environment["FAKE_PLAN"] = plan

        subprocess.run([str(script)], check=True, cwd=temp_dir, env=environment)

        status = {}
        for line in (runtime / "flink-start-status").read_text().splitlines():
            key, value = line.split("=", 1)
            status[key] = value
        return command_log.read_text(), status, runtime

    def test_fresh_install_submits_both_jobs_without_savepoints(self) -> None:
        commands, status, _ = self.run_lifecycle("both")

        self.assertIn("/opt/flink/bin/flink run -d /opt/flink/usrlib/transaction-enrichment.jar", commands)
        self.assertIn("/opt/flink/bin/sql-client.sh sql-client embedded", commands)
        self.assertNotIn("execution.savepoint.path", commands)
        self.assertEqual(status["java"], "fresh")
        self.assertEqual(status["sql"], "fresh")

    def test_provider_notice_and_tty_crlf_do_not_hide_planned_jobs(self) -> None:
        commands, status, _ = self.run_lifecycle("provider-crlf")

        self.assertIn("/opt/flink/bin/flink run -d /opt/flink/usrlib/transaction-enrichment.jar", commands)
        self.assertIn("/opt/flink/bin/sql-client.sh sql-client embedded", commands)
        self.assertEqual(status["java"], "fresh")
        self.assertEqual(status["sql"], "fresh")

    def test_restart_restores_both_jobs_from_recorded_savepoints(self) -> None:
        java_path = "file:/checkpoints/savepoints/savepoint-java"
        sql_path = "file:/checkpoints/savepoints/savepoint-sql"
        commands, status, runtime = self.run_lifecycle("both", (java_path, sql_path))

        self.assertIn(f"run -d -s {java_path}", commands)
        self.assertIn(f"-Dexecution.savepoint.path={sql_path}", commands)
        self.assertEqual(status["java"], f"restored:{java_path}")
        self.assertEqual(status["sql"], f"restored:{sql_path}")
        self.assertFalse((runtime / "flink-savepoints.env").exists())
        self.assertTrue((runtime / "flink-savepoints.applied.env").exists())

    def test_repeated_start_does_not_submit_duplicate_jobs(self) -> None:
        commands, status, _ = self.run_lifecycle("none")

        self.assertNotIn("/opt/flink/bin/flink run", commands)
        self.assertNotIn("/opt/flink/bin/sql-client.sh", commands)
        self.assertEqual(status["java"], "already-running")
        self.assertEqual(status["sql"], "already-running")


if __name__ == "__main__":
    unittest.main()
