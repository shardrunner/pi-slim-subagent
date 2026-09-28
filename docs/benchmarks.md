# Live smoke checks and benchmarks

The normal test suite is offline. This optional harness uses your configured provider credentials and can incur charges. It is available in a source checkout, excluded from the published tarball, and never auto-loaded by the package manifest.

The process inspection harness requires Linux `/proc`. It samples descendants; it is diagnostic evidence, not proof that a short-lived process never existed. Memory figures are host-process RSS, not a per-child allocation profile.

## Run

Choose an authenticated model explicitly; no personal agent definitions or model aliases are required:

```bash
export PI_SUBAGENT_SMOKE_MODEL='provider/model-id'
pi -e ./sdk-smoke.ts
```

In that interactive session:

```text
/sdk-smoke resources
/sdk-smoke single
/sdk-smoke parallel
/sdk-smoke timeout
/sdk-smoke cancel
/sdk-smoke benchmark 10
```

`resources` constructs the real child loader/session without prompting a model. Other commands make live provider calls. Timeout/cancel commands request a `sleep` in the system temporary directory and then check a fresh follow-up dispatch. They use the built-in shell, and therefore still run with your user permissions. Do not run the harness on untrusted inputs.

Reports are JSON written to the terminal. A failed report sets the process exit code. `suite` runs single/parallel/timeout/cancel; run `resources` separately. Save reports only after reviewing them for sensitive paths or provider errors.

## Reproducible reporting

For each measurement, record:

- Git commit, Pi version, Node version, OS/kernel, CPU and memory.
- Provider/model ID, reasoning level, region/endpoint where relevant.
- Task, concurrency, repetitions, timeout, and context configuration.
- Cold versus warm runtime, cache state, and any warmup policy.
- Raw samples, setup time, time-to-first-text, total time, token usage, and failures.

Compare the same task/model/context against a pinned alternative implementation in the same environment. Report medians and variability, not only the best run. Provider/network latency can dominate total duration. Historical hardcoded baseline numbers were removed because their local methodology was not reproducible; this repository currently claims no measured speedup.
