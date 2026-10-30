from __future__ import annotations

import os
import subprocess
import tempfile
import unittest
from pathlib import Path


REPO_DIR = Path(__file__).resolve().parents[2]
COMPOSE_WRAPPER = REPO_DIR / "deployment" / "compose.sh"


class ComposeWrapperTests(unittest.TestCase):
    def run_wrapper(
        self,
        *arguments: str,
        profiles: str | None = None,
        through_common: bool = False,
    ) -> tuple[str, list[str]]:
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            capture_path = temp_path / "capture.txt"
            fake_podman = temp_path / "podman"
            fake_podman.write_text(
                "#!/bin/sh\n"
                "printf '%s\\n' \"$COMPOSE_PROFILES\" >\"$CAPTURE_PATH\"\n"
                "printf '%s\\n' \"$@\" >>\"$CAPTURE_PATH\"\n"
            )
            fake_podman.chmod(0o755)

            environment = os.environ.copy()
            environment["PATH"] = f"{temp_path}:{environment['PATH']}"
            environment["CAPTURE_PATH"] = str(capture_path)
            environment["COMPOSE_PROJECT_NAME"] = "profile-test"
            if profiles is None:
                environment.pop("COMPOSE_PROFILES", None)
            else:
                environment["COMPOSE_PROFILES"] = profiles

            if through_common:
                command = [
                    "/bin/sh",
                    "-c",
                    '. "$1/common.sh"; shift; compose "$@"',
                    str(REPO_DIR / "deployment" / "test-driver.sh"),
                    str(REPO_DIR / "deployment"),
                    *arguments,
                ]
            else:
                command = [str(COMPOSE_WRAPPER), *arguments]
            subprocess.run(command, check=True, cwd=REPO_DIR, env=environment)

            lines = capture_path.read_text().splitlines()
            return lines[0], lines[1:]

    def expected_prefix(self) -> list[str]:
        return [
            "compose",
            "--profile",
            "tools",
            "-p",
            "profile-test",
            "-f",
            str(REPO_DIR / "compose.yaml"),
        ]

    def test_enables_tools_profile_for_profiled_service(self) -> None:
        profiles, arguments = self.run_wrapper("run", "--rm", "migrations")

        self.assertEqual(profiles, "tools")
        self.assertEqual(
            arguments,
            self.expected_prefix() + ["run", "--rm", "migrations"],
        )

    def test_preserves_existing_profiles_and_adds_tools_once(self) -> None:
        profiles, _ = self.run_wrapper("config", profiles="diagnostics")
        self.assertEqual(profiles, "diagnostics,tools")

        profiles, _ = self.run_wrapper("config", profiles="diagnostics,tools")
        self.assertEqual(profiles, "diagnostics,tools")

    def test_common_helper_uses_the_same_command_construction(self) -> None:
        profiles, arguments = self.run_wrapper(
            "run",
            "--rm",
            "--no-deps",
            "checkpoint-init",
            through_common=True,
        )

        self.assertEqual(profiles, "tools")
        self.assertEqual(
            arguments,
            self.expected_prefix()
            + ["run", "--rm", "--no-deps", "checkpoint-init"],
        )


if __name__ == "__main__":
    unittest.main()
