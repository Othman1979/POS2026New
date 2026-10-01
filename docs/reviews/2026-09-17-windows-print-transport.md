# Windows print transport review — 2026-09-17

## Finding and implementation

The Windows helper submitted RAW ESC/POS jobs correctly, but its local queue drain
check waited a fixed 400 ms between `GetJob` calls. The wait owns that printer's
worker lane, so a completed thermal-printer job could sit idle before the next queued
ticket was allowed to enter transport.

The normal path now creates a short-lived Winspool job-change notification after
`EndDocPrinter` has submitted every byte and waits for job set/delete events. Each
event triggers the existing `GetJob` status check. A 400 ms timeout remains as a
watchdog for missed events, and notification setup/wait failure falls back to the
former polling behavior. The handle is closed in `finally`.

This ordering also protects remote providers published under a non-UNC local alias:
a registration stall can no longer happen before the print job reaches Winspool.

`SPOOLER_WINDOWS_DRAIN_STRATEGY=poll` is an immediate operator rollback. It keeps the
same binary and restores fixed 400 ms polling after a spooler restart.

## Zero-output timing and resource measurements

Hardware: local `XP-80C (Copy 1)` on `USB001`, Windows `winprint`, RAW datatype.
Zero-byte RAW jobs created real Windows queue jobs without feeding or cutting paper.
Notification and rollback modes used the same compiled helper.

| Mode | Warm samples | p50 | p95 | Completion path |
|---|---:|---:|---:|---|
| Event notification | 20 | 67.443 ms | 76.734 ms | `notification` on every job |
| Fixed 400 ms rollback | 20 | 448.172 ms | 460.509 ms | `poll` on every job |

A second warmed run used 50 jobs per mode:

| Mode | p50 | p95 | Helper CPU | Working-set change | Private-memory change | Handle change |
|---|---:|---:|---:|---:|---:|---:|
| Event notification | 67.006 ms | 74.459 ms | 0.250 s | +5,562,368 B | +5,345,280 B | +11 |
| Fixed polling | 448.314 ms | 455.769 ms | 0.297 s | +5,488,640 B | +5,271,552 B | +11 |

The process warm-up profile was effectively identical. Notification mode used 46.875
ms less helper CPU across 50 jobs and did not add retained handles or meaningful
memory. It creates no timer or background work while printers are idle.

## Five-cut physical kitchen validation

The physical validation was capped at five cuts. Every job returned `drained` through
the `notification` path; no retry was issued.

| Job | Bytes | Event-driven transport | Earlier same-artifact record |
|---|---:|---:|---:|
| Small cold check | 27 | 82.430 ms | — |
| Kitchen artifact 45 | 49,642 | 646.295 ms | 1,294 ms |
| Kitchen artifact 61, first | 62,826 | 1,092.842 ms | 2,958 ms |
| Kitchen artifact 61, immediate second | 62,826 | 1,058.724 ms | 2,958 ms |
| Small recovery check | 27 | 71.038 ms | — |

The helper consumed 15.625 ms CPU across the five physical jobs. Its handle count
reached 364 after warm-up and stayed at 364 for the remaining three jobs, confirming
that per-job notification handles were released. These exact retained kitchen
artifacts target `XP-80C (Copy 1)` and each contain one cut command.

The same-artifact comparison is historical rather than simultaneous, so driver and
printer state may contribute to the difference. The two new large-ticket repetitions
were consistent. This evidence proves that the event path works on the common XP-80C
driver used by this workstation; customer hardware still needs normal staged rollout
observation.

## Safety and routing

- Kitchen routing is unchanged. Windows-printer kitchen and receipt jobs share this
  helper path; direct TCP printers keep their existing transport.
- `WritePrinter` and `EndDocPrinter` still complete before drain observation.
- The helper still requires the job to disappear or report printed, complete or
  deleted before returning success.
- Drain timeout still deletes a stuck job where possible and reports an uncertain
  outcome, which is never automatically reprinted.
- Notification waits have the prior 400 ms poll as both a watchdog and explicit
  configuration rollback. They never busy-wait.
- UNC printer shares remain on the bounded polling path because notification setup
  can block on remote print-provider or network state.
- Each notification handle is scoped to one print and closed before its printer
  handle.

## Source evidence

Microsoft documents `StartDocPrinter`, `WritePrinter`, `EndDocPrinter` and `GetJob`
as synchronous calls whose duration depends on the driver, queue and connection:

- https://learn.microsoft.com/en-us/windows/win32/printdocs/startdocprinter
- https://learn.microsoft.com/en-us/windows/win32/printdocs/writeprinter
- https://learn.microsoft.com/en-us/windows/win32/printdocs/enddocprinter
- https://learn.microsoft.com/en-us/windows/win32/printdocs/getjob

Microsoft documents printer change notifications as waitable objects that report job
changes and must be reset with `FindNextPrinterChangeNotification`:

- https://learn.microsoft.com/en-us/windows/win32/printdocs/findfirstprinterchangenotification
- https://learn.microsoft.com/en-us/windows/win32/printdocs/findnextprinterchangenotification
