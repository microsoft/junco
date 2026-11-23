# Embedded shell deadlock: pipeline reader starts only after its producer exits

A SafeJIT runner stopped advancing after CheckD. For nearly 37 hours its child `cat .junco/CHECKPOINT-CheckB.md` slept in Linux’s `anon_pipe_write`. `cat` had already read all 58,072 bytes of CheckB. It was waiting to write to a pipe that still held output from CheckA, not waiting on the filesystem or on Lean.

## Reproduce without SafeJIT

Use a disposable Junco `ShellMux` session on Linux, in an empty writable directory. **Submit the pipeline itself to the embedded shell.** Passing it to `/bin/bash -c` tests Bash’s pipeline launcher instead. No model, graph, checkpoint files, or Lean build is needed.

1. Create a file larger than the pipe buffer: `truncate -s 4M checkpoint`.
2. Submit `for f in checkpoint; do cat "$f"; done | cmp - checkpoint` with a 10-second deadline on the shell request. The loop is the first pipeline stage; `cmp` must consume its stdout.
3. Test the shell-function variant separately in a fresh session: `emit() { cat checkpoint; }; emit | cmp - checkpoint`.

**Expected:** both commands finish silently with exit code `0`; `cmp` verifies all 4 MiB arrived unchanged. **Affected build:** the request times out. The external `cat` is blocked writing to stdout, and the downstream `cmp` has not started. A small input can fit entirely in the pipe and hide the bug.

## Cause and regression check

The embedded shell ran the isolated producer loop or function inline during pipeline setup. It waited for that stage to finish before launching the reader. Once the pipe filled, the producer could finish only if the reader drained it, but the reader could start only if the producer finished. Increasing pipe capacity merely moves the failure to a larger input.

The fix starts isolated compound-command and function stages on observed workers so pipeline setup can launch the reader immediately. Standalone commands still execute in the current shell. The regression is [`shell_pipeline_producers_stream_past_pipe_capacity`](crates/marsh/crates/brush-core/tests/external_command_spawner_tests.rs). From the Junco root:

```sh
cargo test --manifest-path crates/marsh/crates/brush-core/Cargo.toml \
  --test external_command_spawner_tests shell_pipeline_producers_stream_past_pipe_capacity -- --exact
```

During the original investigation the focused suite passed all 11 tests, and a checkpoint-shaped replay through `ShellMux` delivered exactly 72,037 bytes and exited `0`. For an end-to-end retest, rebuild the native addon and use a **new runner process**: rebuilding does not replace the addon loaded by a running process.
