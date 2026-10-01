# Spooler timing telemetry and terminal isolation — 2026-09-17

## Purpose

Field reports of a slow kitchen ticket need stage evidence rather than another
speculative delay change. A completed V2 result now carries four bounded values in
the sync request it already sends:

- `render_duration_ms` — renderer-reported artifact generation time.
- `local_duration_ms` — terminal acceptance through completed transport.
- `renderer` — `typst` or `chromium`.
- `transport_mode` — `tcp`, `notification`, `poll`, or `poll_fallback`.

The server stores them in the existing terminal settlement update. This adds no
request, database query, transaction, journal write, timer, worker, or printer lock.
Values outside the known enums or the bounded seven-day timing range become `NULL`.
Old agents remain valid and leave the new columns null; a new agent talking to an
older server only sends ignored JSON properties.

The existing admin print-queue diagnostics download summarizes the latest 1,000
acknowledged jobs. It reports p50/p95/p99 for server queue, server-to-local accept,
render, inferred local overhead, transport, total local, and end-to-end time. Groups
retain `spooler_id`, `agent_id`, `printer_id`, print type, renderer, and transport
mode, so separate terminals and printers never merge into one diagnosis.

## Multi-terminal hardening

The new concurrent Terminal A/Terminal B regression exposed a pre-existing claim
deadlock. After settling their independent jobs, both agents immediately searched
for more kitchen work. MariaDB could choose the queue as the first join table, lock
pending rows globally, and only then filter through each station's printers.

Both claim queries now start with the station's active printers using `STRAIGHT_JOIN`
and use the existing `idx_print_queue_owner_claim (printer_id, status, locked_until,
id)` index. Each terminal therefore locks only queue candidates attached to its own
printer rows. No new index or query was added.

The regression runs two agents with distinct `spooler_id`, `agent_id`, and printer
rows. It first verifies distinct timing values, then performs ten consecutive cycles
where both terminals claim and settle at the same time. All 22 rows acknowledge under
their owning agents, and a foreign-agent settlement remains rejected by the existing
ownership check.

## Performance evidence

The loopback queue harness ran the same journal, Chromium renderer, TCP transport and
byte/hash verification against commit `4cfc8818` and this working tree. No application
database, machine service, or physical printer was contacted.

| Workload | Baseline median first byte | Current median first byte |
|---|---:|---:|
| 200-row report | 423.72 ms | 436.70 ms |
| New kitchen ticket | 473.30 ms | 453.34 ms |
| New receipt | 525.42 ms | 504.38 ms |
| Already rendered artifact | 5.257 ms | 5.355 ms |

The three-sample renderer figures contain normal Chromium noise and move in both
directions. The already-rendered path isolates scheduling and transport: the observed
difference was 0.098 ms. Every received artifact matched its expected byte count and
SHA-256. These measurements support no material print-path regression; they are not
physical-paper or customer-network timings.

## Removal and rollback

Reverting the client/server telemetry code leaves four nullable columns unused and
does not change routing. The additive migration is forward-only and requires no data
backfill. Event-driven Winspool completion retains its separate
`SPOOLER_WINDOWS_DRAIN_STRATEGY=poll` runtime rollback.
