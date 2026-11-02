"""Regression tests for benchmark.py consumer-visible boundaries (real git repos and containers)."""
import json
import subprocess
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest import mock

import docker

import benchmark

IMAGE = "swebench/sweb.eval.x86_64.astropy_1776_astropy-12907:latest"
SHA = "0" * 40


def git(cwd: Path, *args: str) -> str:
    return subprocess.run(["git", "-C", str(cwd), *args], check=True, capture_output=True, text=True).stdout


class OfficialGradeTest(unittest.TestCase):
    def test_absent_or_malformed_reports_are_never_grades(self):
        with tempfile.TemporaryDirectory() as tmp:
            report = Path(tmp) / "report.json"
            with self.assertRaises(OSError):
                benchmark.official_grade(report, "x")
            for content, error in (("", ValueError), ("{}", KeyError), ('{"x": {"resolved": "true"}}', TypeError)):
                report.write_text(content)
                with self.assertRaises(error):
                    benchmark.official_grade(report, "x")
            report.write_text('{"x": {"resolved": false}}')
            self.assertIs(benchmark.official_grade(report, "x"), False)


class OutcomeTest(unittest.TestCase):
    def test_missing_or_contradictory_outcome_is_a_workflow_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            artifacts = Path(tmp)
            self.assertEqual(benchmark.read_outcome(artifacts, 0)[0], "error")
            (artifacts / "outcome.json").write_text(json.dumps({"workflow_status": "completed", "terminal_text": "done", "error": None}))
            self.assertEqual(benchmark.read_outcome(artifacts, 0), ("completed", None))
            status, error = benchmark.read_outcome(artifacts, 1)
            self.assertEqual(status, "error")
            self.assertIn("contradicts", error)
            (artifacts / "outcome.json").write_text(json.dumps({"workflow_status": "completed", "terminal_text": "  ", "error": None}))
            self.assertEqual(benchmark.read_outcome(artifacts, 0)[0], "error")


class CorpusTest(unittest.TestCase):
    def records(self, n: int) -> list[dict]:
        return [{"instance_id": f"o__r-{i}", "repo": "o/r", "base_commit": SHA} for i in range(n)]

    def test_only_exactly_500_unique_safe_ids_form_a_corpus(self):
        self.assertEqual(len(benchmark.checked_records(self.records(500))), 500)
        with self.assertRaises(benchmark.BenchmarkError):
            benchmark.checked_records(self.records(499))
        duplicated = self.records(499) + [self.records(1)[0]]
        with self.assertRaises(benchmark.BenchmarkError):
            benchmark.checked_records(duplicated)
        unsafe = self.records(499) + [{"instance_id": "..", "repo": "o/r", "base_commit": SHA}]
        with self.assertRaises(benchmark.BenchmarkError):
            benchmark.checked_records(unsafe)


class PrepareTest(unittest.TestCase):
    def make_cache(self, tmp: Path, symlink_target: str) -> tuple[Path, str]:
        work = tmp / "work"
        work.mkdir()
        git(work, "init", "-q")
        (work / "pkg").mkdir()
        (work / "pkg" / "mod.py").write_text("x = 1\n")
        (work / "pkg" / "link").symlink_to(symlink_target)
        git(work, "add", "-A")
        git(work, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base")
        sha = git(work, "rev-parse", "HEAD").strip()
        subprocess.run(["git", "clone", "--bare", "-q", str(work), str(tmp / "cache.git")], check=True)
        return tmp / "cache.git", sha

    def test_problem_inputs_exclude_gold_fields(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(benchmark, "ROOT", Path(tmp) / "root"), \
                mock.patch.object(benchmark, "STATE", Path(tmp) / "root" / ".swebench"):
            (Path(tmp) / "root" / ".swebench" / "staging").mkdir(parents=True)
            cache, sha = self.make_cache(Path(tmp), "mod.py")
            gold = {k: f"GOLD-{k}" for k in ("patch", "test_patch", "eval_script", "FAIL_TO_PASS", "PASS_TO_PASS", "hints_text", "image")}
            record = {"instance_id": "o__r-1", "repo": "o/r", "base_commit": sha, "problem_statement": "issue text", **gold}
            self.assertEqual(benchmark.prepare_problem(record, cache), "created")
            problem_dir = Path(tmp) / "root" / "o__r-1"
            problem = json.loads((problem_dir / "problem.json").read_text())
            self.assertEqual(problem, {k: record[k] for k in benchmark.PROBLEM_FIELDS})
            text = "".join(p.read_text(errors="replace") for p in problem_dir.rglob("*") if p.is_file())
            self.assertFalse([v for v in gold.values() if v in text])
            self.assertEqual((problem_dir / "repo" / "pkg" / "link").read_text(), "x = 1\n")
            self.assertEqual(benchmark.prepare_problem(record, cache), "reused")
            with self.assertRaises(benchmark.BenchmarkError):
                benchmark.prepare_problem({**record, "problem_statement": "changed"}, cache)

    def test_archive_links_leaving_the_snapshot_are_rejected(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(benchmark, "ROOT", Path(tmp) / "root"), \
                mock.patch.object(benchmark, "STATE", Path(tmp) / "root" / ".swebench"):
            (Path(tmp) / "root" / ".swebench" / "staging").mkdir(parents=True)
            cache, sha = self.make_cache(Path(tmp), "../../../../outside")
            record = {"instance_id": "o__r-2", "repo": "o/r", "base_commit": sha, "problem_statement": "issue"}
            with self.assertRaises(Exception):
                benchmark.prepare_problem(record, cache)
            self.assertFalse((Path(tmp) / "root" / "o__r-2").exists())
            self.assertEqual(list((Path(tmp) / "root" / ".swebench" / "staging").iterdir()), [])


class PatchExtractionTest(unittest.TestCase):
    def test_modified_deleted_and_new_files_reach_an_applicable_patch(self):
        client = docker.from_env()
        container = client.containers.run(IMAGE, ["tail", "-f", "/dev/null"], detach=True, network_disabled=True)
        try:
            baseline = benchmark.prepare_testbed(container, "d16bfe05a744909de4b27f5875fe0d4ed41ce607")
            sh = ["/bin/bash", "-c"]
            benchmark.exec_checked(container, [*sh, "echo '# edited' >> astropy/modeling/separable.py && git rm -q --cached setup.py && rm setup.py"
                                                     " && mkdir -p newpkg && printf 'y = 2\\n' > newpkg/added.py"], "edit")
            container.stop(timeout=0)  # extraction must also work after the worker stopped the container
            patch = benchmark.extract_patch(container, baseline)
            self.assertIn("diff --git a/astropy/modeling/separable.py b/astropy/modeling/separable.py", patch)
            self.assertIn("deleted file mode", patch.split("diff --git a/setup.py b/setup.py")[1])
            self.assertIn("new file mode", patch.split("diff --git a/newpkg/added.py b/newpkg/added.py")[1])
            benchmark.exec_checked(container, ["git", "-C", "/testbed", "reset", "-q", "--hard", baseline], "reset")
            benchmark.exec_checked(container, ["git", "-C", "/testbed", "clean", "-qfd"], "clean")
            benchmark.exec_checked(container, [*sh, f"cat > /tmp/p.diff <<'EOF'\n{patch}EOF\ngit apply --check /tmp/p.diff"], "apply")
        finally:
            container.remove(force=True)


class SandboxSetupTest(unittest.TestCase):
    def test_a_failed_setup_leaves_no_sandbox_container(self):
        """Every sandbox is created, then baseline verification fails: the instance errors and none survive."""
        client = docker.from_env()
        run_id = uuid.uuid4().hex
        record = {"instance_id": "astropy__astropy-12907", "repo": "astropy/astropy", "base_commit": SHA,
                  "problem_statement": "x", "image": IMAGE}
        with tempfile.TemporaryDirectory() as tmp:
            row, cancelled = benchmark.run_one(record, run_id, Path(tmp), client)
        self.assertFalse(cancelled)
        self.assertEqual((row["workflow_status"], row["evaluation_status"], row["model_patch"]), ("error", "empty_patch", ""))
        self.assertIn("is neither base_commit", row["error"])
        self.assertNotIn("cleanup", row["error"])
        self.assertEqual(client.containers.list(all=True, filters={"name": run_id}), [])


if __name__ == "__main__":
    unittest.main()
