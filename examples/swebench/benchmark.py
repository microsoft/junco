#!/usr/bin/env python3
"""SWE-bench Verified benchmark of the shared Junco workflow junco/examples/swebench/wf.{yml,ts} by default.

prepare: pinned dataset -> <instance_id>/problem.json + base-source repo/ (workflow inputs only).
validate: every problem record checked, and the shared pair checked offline once by run-workflow.ts --check.
run: workflow execution (--parallel defaults to 1), each instance in its own nine disposable containers
     (six agent sandboxes, three pristine acceptance sandboxes), official grading of the canonical patch, JSONL results.

  .venv/bin/python benchmark.py run [--parallel N] [--instance-id <id> ...] [--output <fresh-file.jsonl>]

Without --instance-id the whole corpus runs; repeat it to select several. --output defaults to swebench-cb.jsonl
(under the junco profile optimizer: .swebench/runs/<run>/results.jsonl) and is never overwritten.
Under the junco profile optimizer (JUNCO_PROFILE_RUN_DIR=<dir>), <dir>/cleanup.pending exists while the run may own
containers, and a complete run publishes <dir>/samples.jsonl (every instance's profile.jsonl) and
<dir>/completion.json with metrics `passed` (workflows whose Finish check passed) and `resolved` (official grades).
SWEBENCH_PAIR selects a bare workflow file stem (default wf); predictions are labelled junco-cb for wf, otherwise junco-<stem>.

Models: Pi's saved logins (~/.pi/agent). Telemetry: the worker traces to Opik project `swebench` (API defaults to
localhost:5173/api, overridden by OPIK_URL_OVERRIDE) and persists metrics through Grafana (GRAFANA_URL, default localhost:8000). Per-instance artifacts under
.swebench/runs/<run>/<id>/: requests.jsonl, recordings/ (durable sessions, index.jsonl node -> session), profile.jsonl,
worker.log, outcome.json, patch.diff, the workflow's plans (planning/), checks/, verdicts and patches.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import uuid
from concurrent.futures import CancelledError, ThreadPoolExecutor
from pathlib import Path

class BenchmarkError(Exception):
    pass


ROOT = Path(__file__).resolve().parent
STATE = ROOT / ".swebench"
JUNCO = ROOT / ".junco-snapshot"  # frozen copy of ../junco the runtime imports; REVISION/STATUS record its source
DATASET = "SWE-bench/SWE-bench_Verified"
REVISION = "78f471bf655a3137b2e8a75af1501690ec009ec3"
SPLIT = "test"
HARNESS_COMMIT = "87ab1f6ced28f75ba73ca899dc759b019310944a"
CORPUS_SIZE = 500
PROBLEM_FIELDS = ("instance_id", "repo", "base_commit", "problem_statement")
SAFE_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]*")
SAFE_REPO = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*")
SHA = re.compile(r"[0-9a-f]{40}")
PAIR_NAME = os.environ.get("SWEBENCH_PAIR", "wf")
if re.fullmatch(r"[A-Za-z0-9_-]+", PAIR_NAME) is None:
    raise BenchmarkError("SWEBENCH_PAIR must be a bare file stem")
MODEL_NAME = "junco-cb" if PAIR_NAME == "wf" else f"junco-{PAIR_NAME}"
PAIR = (Path(".junco-snapshot", "examples", "swebench", f"{PAIR_NAME}.yml"), Path(".junco-snapshot", "examples", "swebench", f"{PAIR_NAME}.ts"))
# Container roles of wf.ts ROLES (the worker rejects a manifest that differs): agents work in the
# first six; the acceptance sandboxes are reachable only by the workflow's deterministic code.
AGENT_ROLES = ("canonical", "trace", "reproduce", "contracts", "candidateA", "candidateB")
ROLES = AGENT_ROLES + ("acceptA", "acceptB", "acceptFinal")
EVAL_TIMEOUT = 1800
WORKER_EXIT = {"completed": 0, "error": 1, "cancelled": 130}
ACTIVATE = "source /opt/miniconda3/bin/activate && conda activate testbed"
GIT = ("git", "-c", "safe.directory=/testbed", "-C", "/testbed")


def write_json(path: Path, data: object) -> None:
    """Atomically replace `path` with `data` as JSON."""
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(data, f, indent=2)
            f.write("\n")
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def git(*args: str, **kwargs) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], check=True, capture_output=True, **kwargs)


def checked_records(records: list[dict]) -> list[dict]:
    """The exactly-500 pinned records sorted by instance_id, with path-safe IDs and repos."""
    ids = [r["instance_id"] for r in records]
    if len(records) != CORPUS_SIZE or len(set(ids)) != CORPUS_SIZE:
        raise BenchmarkError(f"expected {CORPUS_SIZE} unique instances, got {len(records)} records / {len(set(ids))} IDs")
    for r in records:
        if not SAFE_ID.fullmatch(r["instance_id"]) or r["instance_id"] in (".", ".."):
            raise BenchmarkError(f"unsafe instance_id {r['instance_id']!r}")
        if not SAFE_REPO.fullmatch(r["repo"]) or ".." in r["repo"]:
            raise BenchmarkError(f"unsafe repo {r['repo']!r} for {r['instance_id']}")
        if not SHA.fullmatch(r["base_commit"]):
            raise BenchmarkError(f"invalid base_commit for {r['instance_id']}")
    return sorted(records, key=lambda r: r["instance_id"])


def load_records() -> list[dict]:
    """The orchestrator-only evaluator records saved by prepare."""
    inventory = json.loads((STATE / "problems.json").read_text())
    if (inventory["dataset"], inventory["revision"], inventory["split"]) != (DATASET, REVISION, SPLIT):
        raise BenchmarkError("problems.json does not match the pinned dataset")
    records = checked_records(json.loads((STATE / "verified.json").read_text()))
    if [r["instance_id"] for r in records] != inventory["instance_ids"]:
        raise BenchmarkError("verified.json and problems.json disagree")
    return records


def bare_cache(repo: str) -> Path:
    """A bare clone of `repo`, private to the orchestrator; archives ignore in-tree export attributes."""
    cache = STATE / "repos" / (repo.replace("/", "__") + ".git")
    if not cache.exists():
        staging = Path(tempfile.mkdtemp(prefix=cache.name + ".", dir=cache.parent))
        try:
            git("clone", "--bare", "--quiet", f"https://github.com/{repo}.git", str(staging / "repo.git"))
            # info/attributes overrides in-tree .gitattributes, so author snapshots are the complete tree.
            (staging / "repo.git" / "info").mkdir(exist_ok=True)
            (staging / "repo.git" / "info" / "attributes").write_text("* -export-ignore -export-subst\n")
            os.rename(staging / "repo.git", cache)
        finally:
            shutil.rmtree(staging, ignore_errors=True)
    return cache


def has_commit(cache: Path, sha: str) -> bool:
    return subprocess.run(["git", "-C", str(cache), "cat-file", "-e", f"{sha}^{{commit}}"], capture_output=True).returncode == 0


def ensure_commits(cache: Path, shas: set[str]) -> None:
    missing = sorted(sha for sha in shas if not has_commit(cache, sha))
    for sha in missing:  # commits unreachable from cloned branches/tags (GitHub serves them by full SHA)
        subprocess.run(["git", "-C", str(cache), "fetch", "--quiet", "origin", sha], capture_output=True)
    absent = [sha for sha in missing if not has_commit(cache, sha)]
    if absent:
        raise BenchmarkError(f"{cache.name}: base commits unavailable: {', '.join(absent)}")


def prepare_problem(record: dict, cache: Path) -> str:
    """Create <instance_id>/{problem.json,repo/} atomically; reuse only an agreeing existing problem."""
    problem = {k: record[k] for k in PROBLEM_FIELDS}
    target = ROOT / record["instance_id"]
    if target.exists():
        existing = target / "problem.json"
        if not existing.is_file() or json.loads(existing.read_text()) != problem or not (target / "repo").is_dir():
            raise BenchmarkError(f"conflicting existing problem directory {target}")
        return "reused"
    staging = Path(tempfile.mkdtemp(prefix=record["instance_id"] + ".", dir=STATE / "staging"))
    try:
        (staging / "repo").mkdir()
        with subprocess.Popen(["git", "-C", str(cache), "archive", "--format=tar", record["base_commit"]],
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE) as proc:
            try:
                with tarfile.open(fileobj=proc.stdout, mode="r|") as tar:
                    # The data filter rejects absolute paths, traversal and links leaving repo/.
                    tar.extractall(staging / "repo", filter="data")
            except BaseException:
                proc.kill()
                raise
            stderr = proc.stderr.read().decode(errors="replace")
        if proc.returncode != 0:
            raise BenchmarkError(f"{record['instance_id']}: git archive failed: {stderr.strip()}")
        write_json(staging / "problem.json", problem)
        os.rename(staging, target)
    finally:
        shutil.rmtree(staging, ignore_errors=True)
    return "created"


def cmd_prepare(_: argparse.Namespace) -> int:
    from datasets import load_dataset

    records = checked_records([dict(r) for r in load_dataset(DATASET, revision=REVISION, split=SPLIT)])
    for d in (STATE, STATE / "repos", STATE / "staging"):
        d.mkdir(exist_ok=True)
    write_json(STATE / "verified.json", records)
    write_json(STATE / "problems.json", {"dataset": DATASET, "revision": REVISION, "split": SPLIT,
                                        "instance_ids": [r["instance_id"] for r in records]})
    by_repo: dict[str, list[dict]] = {}
    for r in records:
        by_repo.setdefault(r["repo"], []).append(r)

    def cache_for(repo: str) -> Path:
        cache = bare_cache(repo)
        ensure_commits(cache, {r["base_commit"] for r in by_repo[repo]})
        return cache

    with ThreadPoolExecutor(max_workers=len(by_repo)) as pool:
        caches = dict(zip(by_repo, pool.map(cache_for, by_repo)))
    with ThreadPoolExecutor(max_workers=16) as pool:
        outcomes = list(pool.map(lambda r: prepare_problem(r, caches[r["repo"]]), records))
    print(f"prepared {len(records)} problems: {outcomes.count('created')} created, {outcomes.count('reused')} reused")
    return 0


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def workflow_entry() -> dict:
    """Relative paths and hashes of the shared pair, as recorded in run metadata and every result row."""
    wf, ts = PAIR
    return {"wf": str(wf), "ts": str(ts), "wf_sha256": sha256(ROOT / wf), "ts_sha256": sha256(ROOT / ts)}


def check_problem(record: dict) -> str | None:
    """None when <instance_id>/problem.json holds exactly the record's workflow inputs beside repo/, else the failure."""
    problem = ROOT / record["instance_id"] / "problem.json"
    try:
        if json.loads(problem.read_text()) != {k: record[k] for k in PROBLEM_FIELDS}:
            return "problem.json differs from the pinned record"
    except (OSError, ValueError) as failure:
        return f"unreadable problem.json: {failure}"
    return None if (problem.parent / "repo").is_dir() else "missing repo/ snapshot"


def check_pair(instance_id: str) -> dict:
    """Offline run-workflow.ts --check of the shared pair against one problem (no model runtime): node -> model."""
    proc = subprocess.run(["bun", "run", "run-workflow.ts", "--check", instance_id], cwd=ROOT,
                          capture_output=True, text=True, env=worker_env(None))
    if proc.returncode != 0:
        raise BenchmarkError(proc.stderr.strip() or proc.stdout.strip() or f"exit {proc.returncode}")
    return json.loads(proc.stdout)["models"]


def validate(records: list[dict]) -> tuple[list[str], dict | None]:
    """Per-record failures plus the shared pair's failure, if any; the pair's node -> model map when it passes."""
    failures = [f"{r['instance_id']}: {error}" for r in records if (error := check_problem(r))]
    try:
        models = check_pair(records[0]["instance_id"])
    except BenchmarkError as failure:
        failures.append(f"shared pair: {failure}")
        models = None
    return failures, models


def cmd_validate(_: argparse.Namespace) -> int:
    records = load_records()
    failures, models = validate(records)
    for failure in failures:
        print(failure, file=sys.stderr)
    bad = len([f for f in failures if not f.startswith("shared pair:")])
    print(f"validate: {len(records) - bad}/{len(records)} problem records pass; shared pair "
          f"{'ok' if models else 'FAILED'}; {len(failures)} failures")
    return 1 if failures else 0


def worker_env(tool_output: Path | None) -> dict[str, str]:
    """Minimal worker environment: Pi's saved login under HOME, telemetry settings (GRAFANA_URL, OPIK_*; the worker
    keeps them from agents), instance-owned shell-output TMPDIR."""
    keep = ("PATH", "HOME", "LANG", "DOCKER_HOST", "DOCKER_CONFIG", "DOCKER_CONTEXT", "DOCKER_CERT_PATH", "DOCKER_TLS_VERIFY",
            "SWEBENCH_PAIR", "JUNCO_PROFILE_RUN_DIR", "JUNCO_GRAPH_RUN_DIR", "GRAFANA_URL")
    env = {k: v for k, v in os.environ.items() if k in keep or k.startswith("OPIK_")}
    if tool_output is not None:
        env["TMPDIR"] = str(tool_output)
    return env


def junco_identity() -> dict:
    """Revision and porcelain status of the ../junco checkout when the runtime snapshot was copied."""
    status = (JUNCO / "STATUS").read_text().splitlines()
    return {"revision": (JUNCO / "REVISION").read_text().strip(), "status": status,
            "dirty": any(not line.startswith("??") for line in status)}


def exec_checked(container, argv: list[str], what: str) -> str:
    result = container.exec_run(argv, workdir="/testbed")
    output = result.output.decode(errors="replace")
    if result.exit_code != 0:
        raise BenchmarkError(f"{what} failed ({result.exit_code}): {output.strip()[-2000:]}")
    return output


def prepare_testbed(container, base_commit: str) -> str:
    """Restore /testbed of this owned disposable container to its recorded baseline and return it.

    Official images commit their environment fixes (e.g. build pins) on top of base_commit; the official
    evaluator applies predictions to that same commit, so it is the baseline when its parent is base_commit.
    """
    head = exec_checked(container, [*GIT, "rev-parse", "HEAD"], "setup: rev-parse").strip()
    if head != base_commit:
        parent = exec_checked(container, [*GIT, "rev-parse", "HEAD^"], "setup: rev-parse parent").strip()
        if parent != base_commit:
            raise BenchmarkError(f"setup: /testbed HEAD {head} is neither base_commit {base_commit} nor its image commit")
    exec_checked(container, [*GIT, "reset", "--hard", head], "setup: git reset")
    exec_checked(container, [*GIT, "clean", "-fd"], "setup: git clean")
    if exec_checked(container, [*GIT, "status", "--porcelain", "--untracked-files=all"], "setup: status").strip():
        raise BenchmarkError("setup: /testbed is not clean at its baseline")
    exec_checked(container, ["/bin/bash", "-lc", f"{ACTIVATE} && python --version"], "setup: testbed environment")
    return head


def start_sandboxes(client, image_id: str, name: str, tool_output: Path, base_commit: str, owned: list) -> tuple[dict, str]:
    """One container per ROLES entry from `image_id`, each restored to the same verified baseline.

    Every created container is appended to `owned` as soon as it exists, so the caller removes partial setups.
    Agent sandboxes see the instance's tool-output directory read-only; acceptance sandboxes see nothing extra.
    """
    def start(role: str) -> tuple:
        volumes = {str(tool_output): {"bind": str(tool_output), "mode": "ro"}} if role in AGENT_ROLES else {}
        container = client.containers.run(image_id, ["tail", "-f", "/dev/null"], detach=True, name=f"{name}.{role.lower()}",
                                          network_disabled=True, volumes=volumes)
        owned.append(container)
        return container, prepare_testbed(container, base_commit)

    with ThreadPoolExecutor(max_workers=len(ROLES)) as pool:
        started = list(pool.map(start, ROLES))
    baselines = {baseline for _, baseline in started}
    if len(baselines) != 1:
        raise BenchmarkError(f"setup: sandboxes disagree on the baseline: {sorted(baselines)}")
    return {role: container for role, (container, _) in zip(ROLES, started)}, baselines.pop()


def extract_patch(container, baseline: str) -> str:
    """Every repository change (modified, deleted, untracked non-ignored) relative to the baseline commit."""
    container.reload()
    if container.status != "running":  # stopped by the worker on a tool timeout/abort; files persist
        container.start()
    exec_checked(container, [*GIT, "add", "-A"], "extraction: git add")
    result = container.exec_run([*GIT, "diff", "--cached", "--binary", baseline, "--"], workdir="/testbed", demux=True)
    stdout, stderr = result.output
    if result.exit_code != 0:
        raise BenchmarkError(f"extraction: git diff failed ({result.exit_code}): {(stderr or b'').decode(errors='replace')[-2000:]}")
    return (stdout or b"").decode()


def read_outcome(artifacts: Path, exit_code: int) -> tuple[str, str | None]:
    """(workflow_status, error) from outcome.json, checked against the worker's exit code."""
    try:
        outcome = json.loads((artifacts / "outcome.json").read_text())
        status, text, error = outcome["workflow_status"], outcome["terminal_text"], outcome["error"]
    except (OSError, ValueError, KeyError, TypeError) as failure:
        return "error", f"workflow: missing or malformed outcome.json (exit {exit_code}): {failure}"
    valid = (status == "completed" and isinstance(text, str) and text.strip() and error is None) or (
        status in ("error", "cancelled") and text is None and isinstance(error, str) and error)
    if not valid or WORKER_EXIT[status] != exit_code:
        return "error", f"workflow: outcome {status!r} contradicts worker exit {exit_code}"
    return status, None if error is None else f"workflow: {error}"


def owned_eval_containers(client, instance_id: str, run_id: str) -> list:
    """Only the harness's exact container name for this instance/run, or that name plus its numeric conflict suffix."""
    name = f"sweb.eval.{instance_id.lower()}.{run_id}"
    pattern = re.compile(re.escape(name) + r"(\.\d+)?")
    return [c for c in client.containers.list(all=True, filters={"name": name}) if pattern.fullmatch(c.name)]


def evaluate(record: dict, prediction: dict, client, run_id: str) -> tuple[str, bool | None, str | None, list[str]]:
    """Official grading in a fresh evaluation container: (evaluation_status, resolved, report_path, errors)."""
    from swebench.harness.constants import LOG_REPORT, RUN_EVALUATION_LOG_DIR
    from swebench.harness.run_evaluation import run_instance
    from swebench.harness.utils import make_test_spec

    errors = []
    iid = record["instance_id"]
    report = RUN_EVALUATION_LOG_DIR / run_id / MODEL_NAME / iid / LOG_REPORT
    try:
        run_instance(make_test_spec(record), prediction, client, run_id, timeout=EVAL_TIMEOUT)
    except Exception as failure:  # the harness logs most failures itself; anything escaping is an evaluation error
        errors.append(f"evaluation: {failure}")
    for leftover in owned_eval_containers(client, iid, run_id):
        try:
            leftover.remove(force=True)
            errors.append(f"evaluation cleanup: removed leftover container {leftover.name}")
        except Exception as failure:
            errors.append(f"evaluation cleanup: could not remove {leftover.name}: {failure}")
    try:
        resolved = official_grade(report, iid)
    except (OSError, ValueError, KeyError, TypeError) as failure:
        errors.append(f"evaluation: no gradable official report ({type(failure).__name__}: {failure}); see {report.parent}")
        return "error", None, str(report) if report.is_file() else None, errors
    return ("resolved" if resolved else "unresolved"), resolved, str(report), errors


def official_grade(report: Path, instance_id: str) -> bool:
    """The official report's boolean `resolved`; raises when the report is absent or malformed."""
    resolved = json.loads(report.read_text())[instance_id]["resolved"]
    if not isinstance(resolved, bool):
        raise TypeError("resolved is not a boolean")
    return resolved


def run_one(record: dict, run_id: str, run_dir: Path, client, stop: threading.Event,
            workers: list[subprocess.Popen], workers_lock: threading.Lock) -> tuple[dict, bool]:
    """One instance end to end; returns (result row, cancelled). Never raises for per-instance failures."""
    import docker

    started = time.monotonic()
    iid, base = record["instance_id"], record["base_commit"]
    artifacts = run_dir / iid
    tool_output = artifacts / "tool-output"
    tool_output.mkdir(parents=True)
    errors: list[str] = []
    workflow_status, patch, cancelled, worker_ran = "error", "", False, False
    owned: list = []
    try:
        try:
            image = client.images.get(record["image"])
        except docker.errors.ImageNotFound:
            image = client.images.pull(record["image"])
        write_json(artifacts / "image.json", {"image": record["image"], "id": image.id, "repo_digests": image.attrs.get("RepoDigests", [])})
        containers, baseline = start_sandboxes(client, image.id, f"junco-cb.{iid.lower()}.{run_id}", tool_output, base, owned)
        write_json(artifacts / "baseline.json", {"base_commit": base, "baseline": baseline})
        write_json(artifacts / "manifest.json", {"baseline": baseline, "containers": {role: c.id for role, c in containers.items()}})
        with open(artifacts / "worker.log", "wb") as log:
            with workers_lock:
                if stop.is_set():
                    cancelled, workflow_status = True, "cancelled"
                    errors.append("cancelled by operator during setup")
                else:
                    worker = subprocess.Popen(["bun", "run", "run-workflow.ts", str(ROOT / iid), str(artifacts / "manifest.json"), str(artifacts)],
                                              cwd=ROOT, env=worker_env(tool_output), stdout=log, stderr=subprocess.STDOUT)
                    workers.append(worker)
                    worker_ran = True
            if worker_ran:
                try:
                    code = worker.wait()
                    cancelled = stop.is_set()
                finally:
                    with workers_lock:
                        workers.remove(worker)
                workflow_status, error = read_outcome(artifacts, code)
                cancelled = cancelled or workflow_status == "cancelled"
                if error:
                    errors.append(error)
    except Exception as failure:
        cancelled = stop.is_set()
        if cancelled:
            workflow_status = "cancelled"
        errors.append(f"setup: {failure}" if not str(failure).startswith("setup:") else str(failure))
    try:
        if worker_ran:  # the deliverable is the canonical sandbox; candidate and acceptance sandboxes are scratch
            patch = extract_patch(containers["canonical"], baseline)
    except Exception as failure:
        errors.append(f"extraction: {failure}")
    finally:
        for container in owned:
            try:
                container.remove(force=True)
            except Exception as failure:
                errors.append(f"cleanup: could not remove container {container.name}: {failure}")
    (artifacts / "patch.diff").write_text(patch)
    prediction = {"instance_id": iid, "model_name_or_path": MODEL_NAME, "model_patch": patch}
    write_json(artifacts / "prediction.json", prediction)
    report_path = None
    cancelled = cancelled or stop.is_set()
    if cancelled:
        evaluation_status, resolved = "error", None
        errors.append("evaluation: skipped after cancellation")
    elif patch == "":
        evaluation_status, resolved = "empty_patch", False
    else:
        evaluation_status, resolved, report_path, evaluation_errors = evaluate(record, prediction, client, run_id)
        errors.extend(evaluation_errors)

    def produced(name: str) -> str | None:
        path = artifacts / name
        return str(path.relative_to(ROOT)) if path.exists() else None
    row = {
        **prediction,
        "run_id": run_id,
        "workflow": workflow_entry(),
        "workflow_status": workflow_status,
        "evaluation_status": evaluation_status,
        "resolved": resolved,
        "error": "; ".join(errors) or None,
        "elapsed_seconds": round(time.monotonic() - started, 3),
        "report_path": report_path,
        "requests_path": produced("requests.jsonl"),
        "recordings_path": produced("recordings"),
        "profile_path": produced("profile.jsonl"),
    }
    return row, cancelled or stop.is_set()


def publish_profile(directory: Path, run_dir: Path, run_id: str, rows: list[dict], client, complete: bool) -> bool:
    """The junco profile optimizer's receipt for this run; True only when published.

    The cleanup guard is released only once docker lists no container of this run. The receipt needs a complete,
    clean run in which every instance's worker proved its spend fully recorded under the request's nonce and graph."""
    if client.containers.list(all=True, filters={"name": run_id}):
        print(f"profile: containers of run {run_id} remain; {directory / 'cleanup.pending'} kept", file=sys.stderr)
        return False
    (directory / "cleanup.pending").unlink()
    if not complete:
        return False
    nonce = json.loads((directory / "request.json").read_text())["nonce"]
    hashes = set()
    for row in rows:
        try:
            proof = json.loads((run_dir / row["instance_id"] / "profile-receipt.json").read_text())
        except (OSError, ValueError) as failure:
            print(f"profile: {row['instance_id']}: spend not proven fully recorded: {failure}", file=sys.stderr)
            return False
        if proof.get("nonce") != nonce:
            print(f"profile: {row['instance_id']}: receipt of another run", file=sys.stderr)
            return False
        hashes.add(proof.get("graphHash"))
    if len(hashes) != 1:
        print(f"profile: instances ran different graph documents: {sorted(map(str, hashes))}", file=sys.stderr)
        return False
    with open(directory / "samples.jsonl", "x") as samples:
        for row in rows:
            profile = run_dir / row["instance_id"] / "profile.jsonl"
            if profile.exists():  # a recorder that recorded nothing writes no file
                samples.write(profile.read_text())
    receipt = {"version": 1, "nonce": nonce, "terminal": True, "graphHash": hashes.pop(), "resourceEvents": 0,
               "metrics": {"passed": sum(r["workflow_status"] == "completed" for r in rows),
                           "resolved": sum(r["resolved"] is True for r in rows)}}
    tmp = directory / "completion.json.tmp"
    with open(tmp, "x") as out:
        json.dump(receipt, out)
    os.rename(tmp, directory / "completion.json")
    return True


def cmd_run(args: argparse.Namespace) -> int:
    if args.parallel < 1:
        raise BenchmarkError("--parallel must be at least 1")
    if os.environ.get("JUNCO_PROFILE_RUN_DIR") is not None and os.environ.get("JUNCO_GRAPH_RUN_DIR") is not None:
        raise BenchmarkError("JUNCO_PROFILE_RUN_DIR and JUNCO_GRAPH_RUN_DIR are both set")
    profile = os.environ.get("JUNCO_PROFILE_RUN_DIR") or os.environ.get("JUNCO_GRAPH_RUN_DIR")
    import docker
    from swebench.harness.reporting import make_run_report

    os.chdir(ROOT)  # the harness writes logs/run_evaluation relative to cwd
    records = load_records()
    wanted = args.instance_id
    selected = [r for r in records if wanted is None or r["instance_id"] in wanted]
    unknown = sorted(set(wanted or ()) - {r["instance_id"] for r in selected})
    if unknown:
        raise BenchmarkError(f"unknown instance_id {', '.join(unknown)}")
    run_id = uuid.uuid4().hex
    run_dir = STATE / "runs" / run_id
    if args.output:
        output = Path(args.output).resolve()
    else:
        output = run_dir / "results.jsonl" if profile else ROOT / "swebench-cb.jsonl"
    if output.exists():
        raise BenchmarkError(f"refusing to overwrite existing output {output}")
    ids = [r["instance_id"] for r in selected]
    failures, models = validate(selected)
    if failures:
        raise BenchmarkError("validation failed:\n" + "\n".join(failures))
    client = docker.from_env(timeout=EVAL_TIMEOUT)
    run_dir.mkdir(parents=True)
    write_json(run_dir / "metadata.json", {
        "run_id": run_id, "dataset": DATASET, "revision": REVISION, "split": SPLIT, "harness_commit": HARNESS_COMMIT,
        "junco": junco_identity(), "workflow": workflow_entry(), "models": models, "instance_ids": ids})
    if profile:
        Path(profile, "cleanup.pending").touch(exist_ok=False)  # held while this run may own containers
    print(f"run {run_id}: {len(ids)} instances -> {output}", flush=True)

    stop = threading.Event()
    workers: list[subprocess.Popen] = []
    workers_lock = threading.Lock()
    rows_lock = threading.Lock()
    rows: list[dict] = []
    signalled = False

    def interrupt(signum, frame):
        nonlocal signalled
        if signalled:  # repeated signals must not re-enter workers_lock
            return
        signalled = True
        stop.set()
        with workers_lock:
            for worker in workers:
                try:
                    worker.send_signal(signal.SIGTERM)
                except ProcessLookupError:
                    pass

    previous_handlers = {sig: signal.signal(sig, interrupt) for sig in (signal.SIGINT, signal.SIGTERM)}
    try:
        with open(output, "x") as out:
            def run(record):
                if stop.is_set():
                    return
                row, cancelled = run_one(record, run_id, run_dir, client, stop, workers, workers_lock)
                with rows_lock:
                    out.write(json.dumps(row) + "\n")
                    out.flush()
                    os.fsync(out.fileno())
                    rows.append(row)
                    print(f"[{len(rows)}/{len(ids)}] {row['instance_id']}: workflow={row['workflow_status']} "
                          f"evaluation={row['evaluation_status']} error={row['error']}", flush=True)
                if cancelled:
                    interrupt(None, None)

            executor = ThreadPoolExecutor(max_workers=args.parallel)
            try:
                futures = []
                for record in selected:
                    if stop.is_set():
                        break
                    futures.append(executor.submit(run, record))
                pending_cancelled = False
                for future in futures:
                    if stop.is_set() and not pending_cancelled:
                        executor.shutdown(wait=False, cancel_futures=True)
                        pending_cancelled = True
                    try:
                        future.result()
                    except CancelledError:
                        pass
            except BaseException:
                interrupt(None, None)
                raise
            finally:
                executor.shutdown(wait=True, cancel_futures=True)
        predictions = {row["instance_id"]: {k: row[k] for k in ("instance_id", "model_name_or_path", "model_patch")} for row in rows}
        make_run_report(predictions, selected, run_id, client, report_dir=str(run_dir))
        resolved = sum(row["resolved"] is True for row in rows)
        counts = {status: sum(row["evaluation_status"] == status for row in rows) for status in ("resolved", "unresolved", "empty_patch", "error")}
        print(f"completed {len(rows)}/{len(ids)}; {counts}; workflow errors {sum(r['workflow_status'] != 'completed' for r in rows)}; "
              f"rows with errors {sum(r['error'] is not None for r in rows)}")
        print(f"resolved {resolved}/{len(ids)}")
        accounting_ok = len(rows) == len(ids) and len({r["instance_id"] for r in rows}) == len(rows)
        infrastructure_ok = counts["error"] == 0 and not any(
            r["error"] and ("setup:" in r["error"] or "cleanup" in r["error"] or "extraction:" in r["error"]) for r in rows)
        ok = accounting_ok and infrastructure_ok and not stop.is_set()
        if profile:
            ok = publish_profile(Path(profile), run_dir, run_id, rows, client, ok)
        return 0 if ok else 1
    finally:
        for sig, previous in previous_handlers.items():
            signal.signal(sig, previous)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("prepare").set_defaults(func=cmd_prepare)
    sub.add_parser("validate").set_defaults(func=cmd_validate)
    run = sub.add_parser("run")
    run.add_argument("--instance-id", action="append")
    run.add_argument("--parallel", type=int, default=1)
    run.add_argument("--output")
    run.set_defaults(func=cmd_run)
    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except (BenchmarkError, subprocess.CalledProcessError) as error:
        detail = error.stderr.decode(errors="replace").strip() if isinstance(error, subprocess.CalledProcessError) and error.stderr else ""
        print(f"{args.command}: {error}{': ' + detail if detail else ''}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
