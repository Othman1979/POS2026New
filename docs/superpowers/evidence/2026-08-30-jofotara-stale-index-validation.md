# JoFotara stale-submission index validation — 2026-08-30

## Decision

Add `idx_jofotara_status_attempt (status, last_attempt_at)` as an isolated additive migration after the event-first JoFotara runner work. The runner reduces how often inactive recovery runs; this index bounds the work done by each stale-submission repair as fiscal history grows.

## Query under test

`markStaleSubmissionsUnknown()` updates rows where `status='submitting'` and `last_attempt_at` is older than two minutes. The index order follows equality first, then the time range.

## Disposable MariaDB experiment

The scratch table contained 100,000 rows: 99,990 accepted rows and 10 stale submitting rows. The database was created only for the probe and dropped in `finally`.

### Exact UPDATE plan

| State | access type | chosen key | estimated rows |
|---|---:|---|---:|
| without index | `index` | `PRIMARY` | 100,000 |
| with index | `range` | `idx_jofotara_status_attempt` | 10 |

### Read-handler confirmation using the same predicate

| State | random-next reads | key reads | index-next reads | matches |
|---|---:|---:|---:|---:|
| without index | 100,001 | 0 | 0 | 10 |
| with index | 0 | 1 | 10 | 10 |

This is a measured reduction from a whole-table scan to the matching stale range. It justifies the small write-amplification cost of one two-column secondary index.

## Migration safety

- Target: `2026-08-30-jofotara-stale-submission-index-v1`.
- Predecessor: exact `2026-08-23-audit-browser-preview-v1` checksum.
- DDL: `ADD INDEX IF NOT EXISTS ... ALGORITHM=INPLACE, LOCK=NONE`; no COPY fallback.
- Preflight: one read-only `SELECT`; accepts an absent index or the exact non-unique `(status, last_attempt_at)` shape and rejects a conflicting same-name shape.
- Normal and automatic SQL normalize to identical bytes.
- Manifest hashes are generated from final normalized files.
- Hostinger fallback copies the automatic SQL verbatim between ordered markers.
- Fresh baseline, test fixture, bootstrap ledger, schema validator, and baseline hash all carry the same authority.

## Verification

- Migration/unit/schema/baseline authority: 124 tests passed.
- Full automatic-migration chain on local MariaDB: 12 tests passed.
- The dedicated MariaDB case proves missing-index first apply, exact ordered index shape, second-run no-op, ledger recording, and conflicting-shape rejection.
- The installer baseline scratch database passes the real startup schema validator.

No production database was changed and no deployment was performed.
