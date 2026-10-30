from __future__ import annotations

import hashlib
import os
import re
import shutil
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path


REPO_DIR = Path(__file__).resolve().parents[2]


def read_env(path: Path) -> dict[str, str]:
    values = {}
    for line in path.read_text().splitlines():
        key, value = line.split("=", 1)
        values[key] = value.strip('"')
    return values


class CredentialLifecycleTests(unittest.TestCase):
    def make_repo(self) -> Path:
        temp_dir = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, temp_dir)
        (temp_dir / "deployment").mkdir()
        fake_bin = temp_dir / "bin"
        fake_bin.mkdir()
        fake_podman = fake_bin / "podman"
        fake_podman.write_text('#!/bin/sh\nexit "${FAKE_VOLUME_RESULT:-1}"\n')
        fake_podman.chmod(0o755)
        script = temp_dir / "deployment" / "ensure_env.sh"
        shutil.copy2(REPO_DIR / "deployment" / "ensure_env.sh", script)
        script.chmod(0o755)
        return temp_dir

    def run_prepare(self, repo: Path, environment: dict[str, str] | None = None) -> None:
        environment = dict(environment or os.environ)
        environment["PATH"] = f"{repo / 'bin'}:{environment['PATH']}"
        subprocess.run(
            [str(repo / "deployment" / "ensure_env.sh")],
            check=True,
            cwd=repo,
            env=environment,
            capture_output=True,
            text=True,
        )

    def prepare_result(
        self, repo: Path, environment: dict[str, str] | None = None
    ) -> subprocess.CompletedProcess[str]:
        environment = dict(environment or os.environ)
        environment["PATH"] = f"{repo / 'bin'}:{environment['PATH']}"
        return subprocess.run(
            [str(repo / "deployment" / "ensure_env.sh")],
            cwd=repo,
            env=environment,
            capture_output=True,
            text=True,
        )

    def password_digest(self, repo: Path) -> str:
        password = read_env(repo / ".env")["POSTGRES_PASSWORD"]
        return hashlib.sha256(password.encode()).hexdigest()

    def test_fresh_generation_is_private_and_url_safe(self) -> None:
        repo = self.make_repo()
        self.run_prepare(repo)

        env_file = repo / ".env"
        values = read_env(env_file)
        self.assertRegex(values["POSTGRES_PASSWORD"], r"^[0-9a-f]{48}$")
        self.assertEqual(stat.S_IMODE(env_file.stat().st_mode), 0o600)

    def test_repeated_make_up_preparation_reuses_credentials(self) -> None:
        repo = self.make_repo()
        self.run_prepare(repo)
        original_digest = self.password_digest(repo)

        self.run_prepare(repo)
        self.assertEqual(self.password_digest(repo), original_digest)

    def test_down_then_up_preparation_reuses_credentials(self) -> None:
        repo = self.make_repo()
        self.run_prepare(repo)
        original_digest = self.password_digest(repo)
        (repo / ".runtime" / "transient-test-state").write_text("stopped")

        self.run_prepare(repo)
        self.assertEqual(self.password_digest(repo), original_digest)

    def test_existing_shell_credentials_do_not_replace_env_file(self) -> None:
        repo = self.make_repo()
        self.run_prepare(repo)
        original_digest = self.password_digest(repo)
        environment = os.environ.copy()
        environment["POSTGRES_PASSWORD"] = "shell-override-must-not-be-written"
        environment["POSTGRES_USER"] = "wrong-shell-user"

        self.run_prepare(repo, environment)
        self.assertEqual(self.password_digest(repo), original_digest)
        self.assertEqual(read_env(repo / ".env")["POSTGRES_USER"], "fraud_app")

    def test_missing_env_with_existing_volume_refuses_new_credentials(self) -> None:
        repo = self.make_repo()
        environment = os.environ.copy()
        environment["FAKE_VOLUME_RESULT"] = "0"

        result = self.prepare_result(repo, environment)

        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((repo / ".env").exists())
        self.assertIn("Refusing to generate .env", result.stderr)

    def test_url_reserved_password_is_rejected_without_replacement(self) -> None:
        repo = self.make_repo()
        self.run_prepare(repo)
        env_file = repo / ".env"
        original = env_file.read_text()
        changed = re.sub(
            r"^POSTGRES_PASSWORD=.*$",
            "POSTGRES_PASSWORD=contains:reserved@characters",
            original,
            flags=re.MULTILINE,
        )
        env_file.write_text(changed)

        result = self.prepare_result(repo)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("URL-unreserved", result.stderr)
        self.assertIn("contains:reserved@characters", env_file.read_text())


class CredentialPropagationTests(unittest.TestCase):
    def test_compose_wrapper_makes_env_file_authoritative(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            repo = Path(temp_dir)
            deployment = repo / "deployment"
            deployment.mkdir()
            wrapper = deployment / "compose.sh"
            shutil.copy2(REPO_DIR / "deployment" / "compose.sh", wrapper)
            wrapper.chmod(0o755)
            (repo / "compose.yaml").write_text("services: {}\n")
            (repo / ".env").write_text(
                "POSTGRES_DB=file_db\n"
                "POSTGRES_USER=file_user\n"
                "POSTGRES_PASSWORD=file_password_value\n"
            )
            fake_bin = repo / "bin"
            fake_bin.mkdir()
            capture = repo / "capture"
            fake_podman = fake_bin / "podman"
            fake_podman.write_text(
                "#!/bin/sh\n"
                "printf '%s\\n' \"$POSTGRES_DB\" \"$POSTGRES_USER\" "
                "\"$POSTGRES_PASSWORD\" >\"$CAPTURE_PATH\"\n"
            )
            fake_podman.chmod(0o755)
            environment = os.environ.copy()
            environment.update(
                {
                    "PATH": f"{fake_bin}:{environment['PATH']}",
                    "CAPTURE_PATH": str(capture),
                    "POSTGRES_DB": "shell_db",
                    "POSTGRES_USER": "shell_user",
                    "POSTGRES_PASSWORD": "shell_password_value",
                }
            )

            subprocess.run([str(wrapper), "config"], check=True, cwd=repo, env=environment)
            self.assertEqual(
                capture.read_text().splitlines(),
                ["file_db", "file_user", "file_password_value"],
            )

    def test_database_urls_use_the_postgres_service_and_shared_variables(self) -> None:
        compose = (REPO_DIR / "compose.yaml").read_text()
        expected = (
            "postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}"
            "@postgres:5432/${POSTGRES_DB}"
        )

        self.assertGreaterEqual(compose.count(expected), 4)
        self.assertRegex(compose, re.compile(r"POSTGRES_DB: \$\{POSTGRES_DB\}"))
        self.assertRegex(compose, re.compile(r"POSTGRES_USER: \$\{POSTGRES_USER\}"))
        self.assertRegex(compose, re.compile(r"POSTGRES_PASSWORD: \$\{POSTGRES_PASSWORD\}"))


class CredentialPreflightTests(unittest.TestCase):
    def run_preflight(self, result: int) -> subprocess.CompletedProcess[str]:
        temp_dir = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, temp_dir)
        deployment = temp_dir / "deployment"
        deployment.mkdir()
        script = deployment / "check_postgres_credentials.sh"
        shutil.copy2(REPO_DIR / "deployment" / "check_postgres_credentials.sh", script)
        script.chmod(0o755)
        (deployment / "common.sh").write_text(
            "repo_dir=$(CDPATH= cd -- \"$(dirname -- \"$0\")/..\" && pwd)\n"
            "project=credential-test\n"
            "compose() { return \"$FAKE_COMPOSE_RESULT\"; }\n"
        )
        environment = os.environ.copy()
        environment["FAKE_COMPOSE_RESULT"] = str(result)
        environment["POSTGRES_PASSWORD"] = "must-not-appear"
        return subprocess.run(
            [str(script)],
            cwd=temp_dir,
            env=environment,
            capture_output=True,
            text=True,
        )

    def test_successful_preflight_allows_migrations(self) -> None:
        result = self.run_preflight(0)
        self.assertEqual(result.returncode, 0)
        self.assertIn("credentials verified", result.stdout)

    def test_mismatch_stops_without_disclosing_credentials(self) -> None:
        result = self.run_preflight(10)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("retained volume", result.stderr)
        self.assertNotIn("must-not-appear", result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
