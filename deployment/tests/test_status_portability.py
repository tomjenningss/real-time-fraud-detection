from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


REPO_DIR = Path(__file__).resolve().parents[2]


class StatusPortabilityTests(unittest.TestCase):
    def test_status_works_when_compose_ps_rejects_all_options(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            deployment = temp_path / "deployment"
            runtime = temp_path / ".runtime"
            deployment.mkdir()
            runtime.mkdir()
            status = deployment / "status.sh"
            shutil.copy2(REPO_DIR / "deployment" / "status.sh", status)
            status.chmod(0o755)
            (deployment / "common.sh").write_text(
                "repo_dir=$(CDPATH= cd -- \"$(dirname -- \"$0\")/..\" && pwd)\n"
                "project=status-test\n"
                "compose() {\n"
                "  if [ \"$1\" = ps ]; then\n"
                "    [ \"$#\" -eq 1 ] || { echo 'old podman-compose rejected ps option' >&2; return 64; }\n"
                "    echo 'portable container summary'\n"
                "  fi\n"
                "  return 0\n"
                "}\n"
                "service_container_id() { printf 'container-id\\n'; }\n"
                "env_value() { case \"$1\" in CORRELATOR_HOST_PORT) echo 18082 ;; *) echo 18083 ;; esac; }\n"
                "podman() {\n"
                "  case \"$*\" in *Health*) echo healthy ;; *) echo running ;; esac\n"
                "}\n"
                "curl() { return 0; }\n"
            )

            result = subprocess.run(
                [str(status)],
                cwd=temp_path,
                env=os.environ.copy(),
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("portable container summary", result.stdout)
            self.assertIn("All required development deployment components are ready", result.stdout)

    def test_required_service_lookup_includes_stopped_project_containers(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            capture_path = temp_path / "arguments.txt"
            fake_podman = temp_path / "podman"
            fake_podman.write_text(
                "#!/bin/sh\n"
                "printf '%s\\n' \"$@\" >\"$CAPTURE_PATH\"\n"
                "printf 'stopped-container-id\\n'\n"
            )
            fake_podman.chmod(0o755)
            environment = os.environ.copy()
            environment["PATH"] = f"{temp_path}:{environment['PATH']}"
            environment["CAPTURE_PATH"] = str(capture_path)
            environment["COMPOSE_PROJECT_NAME"] = "status-test"

            result = subprocess.run(
                [
                    "/bin/sh",
                    "-c",
                    '. "$1/common.sh"; service_container_id kafka',
                    str(REPO_DIR / "deployment" / "test-driver.sh"),
                    str(REPO_DIR / "deployment"),
                ],
                cwd=REPO_DIR,
                env=environment,
                text=True,
                capture_output=True,
                check=True,
            )

            self.assertEqual(result.stdout.strip(), "stopped-container-id")
            self.assertEqual(
                capture_path.read_text().splitlines(),
                [
                    "ps",
                    "-a",
                    "--filter",
                    "label=com.docker.compose.project=status-test",
                    "--filter",
                    "label=com.docker.compose.service=kafka",
                    "--format",
                    "{{.ID}}",
                ],
            )


if __name__ == "__main__":
    unittest.main()
