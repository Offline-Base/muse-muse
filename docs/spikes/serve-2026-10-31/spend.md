# Serve test spend (cap $25)

| What | Meta $ | Sandbox $ | Running total |
|---|---|---|---|
| Free probes (403 firewall, echo), 9 small sandboxes, about 6 min of 2 vCPU | 0 | 0.05 | 0.05 |
| Paid probe: one Wonder turn at low effort (2 main calls, 4 reminders) | 0.23 | 0.01 | 0.29 |
| Build A (serve + full): live, no fix round, 8.5 min | 4.75 | 0.10 | 5.14 |
| Paid probe: a question and its answer through the real bridge, low effort | 0.15 | 0.01 | 5.30 |
| Build B (serve + full): one steer, injected typecheck failure, one fix round, live, 13.7 min | 6.76 | 0.15 | 12.21 |
| Build C (serve + full): goal edit, interrupt, steer, Stop at 2 min; failed as Stopped by you | 1.62 | 0.05 | 13.88 |
| A2 refinement of A (serve + full): queued note, live, 5.7 min | 3.87 | 0.05 | 17.80 |
| Build X (flags off, exec): live, no fix round, 4.8 min | 2.00 | 0.03 | 19.83 |
