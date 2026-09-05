# Terminal diagnostics and release gates

Terminal diagnostics are local, bounded, and content-free. They never include PTY input or output, commands, titles, working directories, environment values, credentials, full URLs, archives, screenshots, or memory dumps.

## Endpoints

- `GET /terminal/health` is liveness: the HTTP event loop answered.
- `GET /terminal/api/v1/readiness` is readiness: the store and terminal runtime can serve work. It returns `503` while unavailable.
- `GET /terminal/api/v1/status` is authenticated detailed status.
- `GET /terminal/api/v1/metrics` is an authenticated, vendor-neutral JSON snapshot. It contains bounded dimensions only and no resource IDs.

Metrics collection sends bounded diagnostic commands to terminal shards. It does not acquire a terminal authority or wait on PTY, socket, or history I/O.

## Support bundles

Review the inventory before generating a bundle:

```sh
vp run diagnostics:bundle -- --dry-run
vp run diagnostics:bundle -- --confirm
```

The generated directory is mode `0700`; files are mode `0600`. Nothing uploads automatically. Review and delete it after use.

## Runbooks

| Signal                       | Safe action                                                                                                                                        |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host unreachable             | Check liveness and process/service state. Do not restart until users understand that host loss terminates PTYs.                                    |
| Readiness red                | Check store availability and disk permissions/capacity. Keep the process available for diagnostics.                                                |
| Reconnect or resync storm    | Inspect resync counters, queue high water, and epoch changes. Capture a support bundle; do not increase queue limits.                              |
| Replay gap                   | Preserve the archive, verify its health metadata, and let the client request an authoritative resnapshot. Never present partial history as exact.  |
| History pressure/corruption  | Stop retention-destructive maintenance, preserve checksummed files, and use the typed degraded state. Do not paste terminal content into an issue. |
| Authentication denial/revoke | Verify device status and scope locally. Re-pair only after comparing the host identity. Never share a token.                                       |
| High memory                  | Compare hot/warm/parked session counts, queue bytes, and history staging capacity. Run the bounded soak reproducer.                                |
| Slow typing                  | Separate input queue wait, worker parse, model commit, frame submit, and frame present. Profile the failing phase before changing a budget.        |
| Failed update/restart        | Treat prior PTYs as ended; verify catalog/history are marked interrupted and inspect process-cleanup diagnostics.                                  |

## Quality reports

`tests/bench/slos.json` is the reviewed objective registry. See [terminal performance budgets](./terminal-performance-budgets.md) for refresh-aware proxy targets, paced workloads, overload recovery, and the distinction between enforced and specified objectives. Threshold changes require a reason and review; correctness remains zero-tolerance. Generate component reports with `test:compatibility`, `test:chaos`, and `test:soak`, then run `release:quality`. Missing dimensions fail the report rather than becoming zero.
