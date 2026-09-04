# Terminal runtime benchmark evidence

## 2026-09-04 protocol-v4 verification

Command:

```sh
/usr/bin/time -l cargo test --release \
  --manifest-path packages/yaade-server/Cargo.toml \
  --lib benchmark_one_thousand_parkable_sessions -- --ignored --nocapture
```

Observed runtime output on the Apple M4/macOS reference host:

```text
requested=1000 admitted=509
create_ms=3549
rss_base_kib=3184
rss_active_kib=41584
rss_warm_kib=41600
rss_parked_kib=41616
rss_delta_kib=38400
shards=8
p50_wake_us=16106
p95_wake_us=22520
p99_wake_us=22761
shutdown_ms=5540
```

The release test passed byte delivery, fixed owner count, parking, wake, and shutdown assertions. Admission stopped at 509 because this host reached its macOS PTY ceiling (`openpty` returned `ENXIO`); the runtime still requested 1,000. The timed command completed in 51.92 seconds including an 11.80-second incremental release build (`57.26s` user CPU, `5.23s` system CPU). Its process-tree maximum RSS was 1,378,385,920 bytes because `/usr/bin/time` included Cargo and rustc; the probe's in-process active-to-parked runtime delta was 38,400 KiB. The burst also exercised explicit bounded-history degradation without blocking live PTY delivery.

## 2026-08-19 fixed-reactor scale probe

Command:

```sh
cargo test --release --manifest-path packages/yaade-server/Cargo.toml \
  --lib benchmark_one_thousand_parkable_sessions -- --ignored --nocapture
```

Environment:

- Git base: `d24821f3b0bc1e8f307dfd9f86724178a6e293a3` plus the working-tree terminal migration
- Apple M4, 24 GiB RAM
- macOS 27.0 build 26A5425a, Darwin 27.0.0 arm64
- `rustc 1.96.0 (ac68faa20 2026-05-25)`, release profile
- Ghostty revision: `07bccf7a311acdfa6afc77f2016160d49b1f1982`
- Fixture: directly launched `/bin/cat`; one `x\n` write and observed echo per PTY
- Eight reactor shards; 64 ready descriptors, 64 KiB PTY write work, and 64 terminal commands per turn
- Per-terminal input queue: 2 MiB; live connection lane: 32 MiB; history connection lane: 2 MiB; history ingest: 1,024 messages / 32 MiB

Observed output:

```text
requested=1000 admitted=507
create_ms=3668
rss_base_kib=3152
rss_active_kib=41248
rss_warm_kib=41280
rss_parked_kib=41296
rss_delta_kib=38096
shards=8
p50_wake_us=11400
p95_wake_us=19840
p99_wake_us=20750
shutdown_ms=6717
```

This run passed byte-delivery and fixed-owner-count assertions for every admitted PTY. The process admitted 507 because this macOS host reports `kern.tty.ptmx_max=511`; the 508th fixture PTY failed with `ENXIO` (`Device not configured`). This is an operating-system PTY ceiling, not the server's 1,000-session admission limit. Consequently this run is evidence for 507 physical PTYs and is **not** evidence for 1,000 physical PTYs. The checked-in probe continues requesting 1,000 and reports the admitted count so a Linux or reconfigured host can supply that release-gate result without changing the fixture.

The burst intentionally exposed bounded history degradation: the nonblocking history ingest mailbox saturated while all PTYs echoed concurrently. Live PTY delivery still completed. This confirms the overload boundary but means this run is not a durable-history throughput benchmark.

After creation, the probe waits past the 5-second warm threshold and then the 30-second parked threshold; all 507 sessions must be reported parked before wake input begins. The RSS values are process-wide and include each child's host-side PTY/runtime resources visible in the server process; they are not heap-allocation attribution. The wake latency values measure accepted input on a parked session to first observed output position. Shutdown measures concurrent shard shutdown and worker joins.
