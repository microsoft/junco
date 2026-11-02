"""Regression tests for benchmark.py consumer-visible boundaries (real git repos and containers)."""
import argparse
import contextlib
import io
import math
import json
import os
import signal
import subprocess
import sys
import tempfile
import threading
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


class PairSelectionTest(unittest.TestCase):
    def selected_pair(self, stem: str | None) -> subprocess.CompletedProcess:
        env = os.environ.copy()
        env.pop("SWEBENCH_PAIR", None)
        if stem is not None:
            env["SWEBENCH_PAIR"] = stem
        return subprocess.run(
            [sys.executable, "-c", "import json, benchmark; print(json.dumps({"
             "'name': benchmark.PAIR_NAME, 'pair': [str(p) for p in benchmark.PAIR], "
             "'model': benchmark.MODEL_NAME, 'worker_pair': benchmark.worker_env(None).get('SWEBENCH_PAIR'), "
             "'roles': list(benchmark.ROLES)}))"],
            cwd=Path(benchmark.__file__).parent, env=env, capture_output=True, text=True,
        )


    def test_solo_pair_changes_paths_model_and_worker_environment(self):
        result = self.selected_pair("solo")
        self.assertEqual(result.returncode, 0, result.stderr)
        selected = json.loads(result.stdout)
        self.assertEqual(selected["name"], "solo")
        self.assertEqual(selected["pair"], [".junco-snapshot/examples/swebench/solo.yml", ".junco-snapshot/examples/swebench/solo.ts"])
        self.assertEqual(selected["model"], "junco-solo")
        self.assertEqual(selected["worker_pair"], "solo")
        self.assertEqual(selected["roles"], ["canonical", "trace", "reproduce", "contracts", "candidateA", "candidateB", "acceptA", "acceptB", "acceptFinal"])

    def test_invalid_pair_stems_raise_benchmark_error(self):
        for stem in ("", "../solo", "/solo", "solo.yml", "solo/path", "solo\\path", "solo\n", "sölö"):
            with self.subTest(stem=stem):
                result = self.selected_pair(stem)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("BenchmarkError: SWEBENCH_PAIR must be a bare file stem", result.stderr)
                self.assertEqual(result.stdout, "")


class OptimizerReceiptTest(unittest.TestCase):
    def fixture(self, root: Path):
        directory = root / "optimizer"
        directory.mkdir()
        request = {"version": 1, "nonce": "request-nonce", "expectedGraphHash": "candidate-hash"}
        (directory / "request.json").write_text(json.dumps(request))
        (directory / "cleanup.pending").touch()
        run_dir = root / "run"
        rows = [
            {"instance_id": "o__r-1", "workflow_status": "completed", "resolved": False},
            {"instance_id": "o__r-2", "workflow_status": "error", "resolved": True},
        ]
        samples = []
        for i, row in enumerate(rows):
            artifacts = run_dir / row["instance_id"]
            artifacts.mkdir(parents=True)
            (artifacts / "profile-receipt.json").write_text(json.dumps({
                "nonce": request["nonce"], "graphHash": request["expectedGraphHash"],
            }))
            sample = json.dumps({"kind": "usage", "usd": i + 0.25}) + "\n"
            (artifacts / "profile.jsonl").write_text(sample)
            samples.append(sample)
        client = mock.Mock()
        client.containers.list.return_value = []
        return directory, run_dir, rows, client, request, "".join(samples)

    def test_graph_request_publishes_official_row_metrics_and_all_samples(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory, run_dir, rows, client, request, samples = self.fixture(Path(tmp))
            self.assertTrue(benchmark.publish_profile(directory, run_dir, "run-id", rows, client, True))
            receipt = json.loads((directory / "completion.json").read_text())
            self.assertEqual(receipt, {
                "version": 1, "nonce": request["nonce"], "terminal": True,
                "graphHash": request["expectedGraphHash"], "resourceEvents": 0,
                "metrics": {"passed": 1, "resolved": 1},
            })
            self.assertTrue(all(math.isfinite(value) for value in receipt["metrics"].values()))
            self.assertEqual((directory / "samples.jsonl").read_text(), samples)
            self.assertFalse((directory / "cleanup.pending").exists())
            client.containers.list.assert_called_once_with(all=True, filters={"name": "run-id"})

    def test_unproven_or_unclean_runs_never_publish(self):
        for failure in ("incomplete", "missing-proof", "stale-nonce", "different-graphs", "containers"):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as tmp:
                directory, run_dir, rows, client, request, _ = self.fixture(Path(tmp))
                proof = run_dir / rows[1]["instance_id"] / "profile-receipt.json"
                if failure == "missing-proof":
                    proof.unlink()
                elif failure == "stale-nonce":
                    proof.write_text(json.dumps({"nonce": "stale", "graphHash": request["expectedGraphHash"]}))
                elif failure == "different-graphs":
                    proof.write_text(json.dumps({"nonce": request["nonce"], "graphHash": "other"}))
                elif failure == "containers":
                    client.containers.list.return_value = [object()]
                self.assertFalse(benchmark.publish_profile(
                    directory, run_dir, "run-id", rows, client, failure != "incomplete"))
                self.assertFalse((directory / "completion.json").exists())
                self.assertFalse((directory / "samples.jsonl").exists())
                self.assertEqual((directory / "cleanup.pending").exists(), failure == "containers")

    def test_both_optimizer_environments_rejected_before_work(self):
        for value in ("/tmp/profile-request", ""):
            with self.subTest(value=value), mock.patch.dict(os.environ, {
                "JUNCO_PROFILE_RUN_DIR": value, "JUNCO_GRAPH_RUN_DIR": "/tmp/graph-request",
            }), mock.patch.object(benchmark, "load_records") as records, \
                    mock.patch.object(benchmark, "validate") as validate, \
                    mock.patch.object(docker, "from_env") as connect, \
                    mock.patch.object(benchmark.subprocess, "Popen") as worker:
                with self.assertRaisesRegex(benchmark.BenchmarkError, "are both set"):
                    benchmark.cmd_run(argparse.Namespace(parallel=1))
                records.assert_not_called()
                validate.assert_not_called()
                connect.assert_not_called()
                worker.assert_not_called()



class ParallelRunTest(unittest.TestCase):
    @contextlib.contextmanager
    def fixture(self, root, run_one, report, progress=None):
        records = [{"instance_id": f"o__r-{i}", "repo": "o/r", "base_commit": SHA} for i in range(3)]
        output = root / "results.jsonl"
        stdout = io.StringIO()
        handlers = {}
        client = mock.Mock()

        def capture_signal(signum, handler):
            previous = handlers.get(signum, signal.SIG_DFL)
            handlers[signum] = handler
            return previous

        def capture_print(*args, **kwargs):
            print(*args, **{**kwargs, "file": stdout})
            if progress is not None:
                progress(" ".join(map(str, args)))

        with mock.patch.dict(os.environ, {}, clear=True), \
                mock.patch.object(benchmark, "ROOT", root), \
                mock.patch.object(benchmark, "STATE", root / ".swebench"), \
                mock.patch.object(benchmark.os, "chdir"), \
                mock.patch.object(benchmark, "load_records", return_value=records), \
                mock.patch.object(benchmark, "validate", return_value=([], {})), \
                mock.patch.object(benchmark, "junco_identity", return_value={}), \
                mock.patch.object(benchmark, "workflow_entry", return_value={}), \
                mock.patch.object(benchmark.signal, "signal", side_effect=capture_signal), \
                mock.patch.object(docker, "from_env", return_value=client), \
                mock.patch.object(benchmark, "run_one", side_effect=run_one), \
                mock.patch("swebench.harness.reporting.make_run_report", side_effect=report), \
                mock.patch.object(benchmark, "print", side_effect=capture_print, create=True):
            yield records, output, stdout, handlers

    def row(self, record, cancelled=False):
        return {"instance_id": record["instance_id"], "model_name_or_path": benchmark.MODEL_NAME,
                "model_patch": "" if cancelled else f"patch for {record['instance_id']}",
                "workflow_status": "cancelled" if cancelled else "completed",
                "evaluation_status": "error" if cancelled else "unresolved",
                "resolved": None if cancelled else False,
                "error": "evaluation: skipped after cancellation" if cancelled else None}

    def test_parallel_workers_overlap_and_publish_once_in_completion_order(self):
        first_started = threading.Event()
        third_written = threading.Event()
        state_lock = threading.Lock()
        active = set()
        drained = []
        reports = []

        def progress(line):
            if line.startswith("[2/3] o__r-2:"):
                third_written.set()

        def run_one(record, run_id, run_dir, client, stop, workers, workers_lock):
            iid = record["instance_id"]
            with state_lock:
                active.add(iid)
            try:
                if iid == "o__r-0":
                    first_started.set()
                    self.assertTrue(third_written.wait(10), "later workers did not finish while first was active")
                else:
                    self.assertTrue(first_started.wait(10), "first worker never started")
                    with state_lock:
                        self.assertEqual(active, {"o__r-0", iid})
                return self.row(record), False
            finally:
                with state_lock:
                    active.remove(iid)
                    drained.append(iid)

        def report(predictions, selected, run_id, client, **kwargs):
            self.assertFalse(active)
            self.assertCountEqual(drained, [r["instance_id"] for r in records])
            rows = [json.loads(line) for line in output.read_text().splitlines()]
            self.assertEqual(list(predictions), [row["instance_id"] for row in rows])
            self.assertEqual(selected, records)
            self.assertTrue((Path(kwargs["report_dir"]) / "metadata.json").exists())
            reports.append(predictions)

        with tempfile.TemporaryDirectory() as tmp, self.fixture(Path(tmp), run_one, report, progress) as fixture:
            records, output, stdout, _ = fixture
            result = benchmark.cmd_run(argparse.Namespace(instance_id=None, output=str(output), parallel=2))
            self.assertEqual(result, 0)
            rows = [json.loads(line) for line in output.read_text().splitlines()]
            self.assertEqual([row["instance_id"] for row in rows], ["o__r-1", "o__r-2", "o__r-0"])
            self.assertEqual(len(reports), 1)
            progress_lines = [line for line in stdout.getvalue().splitlines() if line.startswith("[")]
            self.assertEqual(len(progress_lines), 3)
            for index, row in enumerate(rows, 1):
                self.assertTrue(progress_lines[index - 1].startswith(f"[{index}/3] {row['instance_id']}:"))
            self.assertIn("completed 3/3", stdout.getvalue())

    def test_signals_stop_queued_work_terminate_registered_workers_and_drain_before_report(self):
        for signum in (signal.SIGINT, signal.SIGTERM):
            with self.subTest(signal=signum):
                first_started = threading.Event()
                release = threading.Event()
                reported = threading.Event()
                state_lock = threading.Lock()
                started = []
                drained = []
                registered = []
                registry = []

                def run_one(record, run_id, run_dir, client, stop, workers, workers_lock):
                    iid = record["instance_id"]
                    self.assertNotEqual(iid, "o__r-2", "queued work ran after cancellation")
                    terminated = threading.Event()
                    worker = mock.Mock()
                    worker.send_signal.side_effect = lambda received: terminated.set() if received == signal.SIGTERM else None

                    def wait():
                        self.assertTrue(terminated.wait(10), "registered worker never received SIGTERM")
                        return -signal.SIGTERM

                    worker.wait.side_effect = wait
                    with workers_lock:
                        self.assertFalse(stop.is_set())
                        workers.append(worker)
                    with state_lock:
                        started.append(iid)
                        registered.append(worker)
                        registry.append(workers)
                    try:
                        if iid == "o__r-0":
                            first_started.set()
                        else:
                            self.assertTrue(first_started.wait(10), "first worker never started")
                            with state_lock:
                                self.assertCountEqual(started, ["o__r-0", "o__r-1"])
                            handlers[signum](signum, None)
                            release.set()
                            self.assertTrue(stop.is_set())
                            self.assertFalse(reported.is_set())
                        self.assertTrue(release.wait(10), "cancellation handler did not return")
                        worker.wait()
                        self.assertTrue(stop.is_set())
                        return self.row(record, cancelled=True), True
                    finally:
                        with workers_lock:
                            workers.remove(worker)
                        with state_lock:
                            drained.append(iid)

                def report(predictions, selected, run_id, client, **kwargs):
                    self.assertCountEqual(drained, ["o__r-0", "o__r-1"])
                    self.assertTrue(all(not workers for workers in registry))
                    self.assertEqual(len(selected), 3)
                    self.assertCountEqual(predictions, started)
                    self.assertEqual(len(output.read_text().splitlines()), 2)
                    for worker in registered:
                        worker.send_signal.assert_called_once_with(signal.SIGTERM)
                        worker.wait.assert_called_once_with()
                    reported.set()

                with tempfile.TemporaryDirectory() as tmp, self.fixture(Path(tmp), run_one, report) as fixture:
                    _, output, stdout, handlers = fixture
                    result = benchmark.cmd_run(argparse.Namespace(instance_id=None, output=str(output), parallel=2))
                    self.assertEqual(result, 1)
                    self.assertTrue(reported.is_set())
                    self.assertCountEqual(started, ["o__r-0", "o__r-1"])
                    rows = [json.loads(line) for line in output.read_text().splitlines()]
                    self.assertCountEqual([row["instance_id"] for row in rows], started)
                    self.assertTrue(all(row["workflow_status"] == "cancelled" and row["evaluation_status"] == "error"
                                        and row["resolved"] is None for row in rows))
                    self.assertIn("completed 2/3", stdout.getvalue())


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
            row, cancelled = benchmark.run_one(record, run_id, Path(tmp), client,
                                               threading.Event(), [], threading.Lock())
        self.assertFalse(cancelled)
        self.assertEqual((row["workflow_status"], row["evaluation_status"], row["model_patch"]), ("error", "empty_patch", ""))
        self.assertIn("is neither base_commit", row["error"])
        self.assertNotIn("cleanup", row["error"])
        self.assertEqual(client.containers.list(all=True, filters={"name": run_id}), [])


if __name__ == "__main__":
    unittest.main()
