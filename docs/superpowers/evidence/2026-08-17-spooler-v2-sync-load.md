# Spooler V2 sync load evidence

Date: 2026-08-17

Command shape:

```text
node backend/tests/manual/spoolerV2LoadHarness.js <agents> 60
```

The harness recreated only the disposable `posapp_test` database, started an ephemeral loopback HTTP server, registered agent-minted identities, synced each agent every two seconds, and closed the server, Socket.IO, and database pool after each independent run.

## Raw results

```json
{"agents":1,"seconds":60,"syncs":30,"request_rate_per_second":0.5,"p50_ms":5,"p95_ms":7,"p99_ms":7,"pool":{"created":0,"acquired":62,"released":62,"enqueued":0,"connectionErrors":0,"peak_in_use":1,"active_at_end":0},"event_loop_delay_ms":{"mean":30.69,"p95":31.2,"max":33.69}}
{"agents":5,"seconds":60,"syncs":150,"request_rate_per_second":2.42,"p50_ms":4,"p95_ms":7,"p99_ms":10,"pool":{"created":0,"acquired":302,"released":302,"enqueued":0,"connectionErrors":0,"peak_in_use":1,"active_at_end":0},"event_loop_delay_ms":{"mean":30.55,"p95":31.41,"max":32.52}}
{"agents":10,"seconds":60,"syncs":300,"request_rate_per_second":4.84,"p50_ms":5,"p95_ms":7,"p99_ms":8,"pool":{"created":1,"acquired":602,"released":602,"enqueued":0,"connectionErrors":0,"peak_in_use":2,"active_at_end":0},"event_loop_delay_ms":{"mean":30.27,"p95":31.39,"max":32.36}}
{"agents":50,"seconds":60,"syncs":1490,"request_rate_per_second":24.13,"p50_ms":8,"p95_ms":11,"p99_ms":16,"pool":{"created":9,"acquired":2982,"released":2982,"enqueued":0,"connectionErrors":0,"peak_in_use":10,"active_at_end":0},"event_loop_delay_ms":{"mean":30.49,"p95":31.39,"max":35.09}}
{"agents":100,"seconds":60,"syncs":2980,"request_rate_per_second":48.27,"p50_ms":11,"p95_ms":16,"p99_ms":19,"pool":{"created":9,"acquired":1788,"released":1788,"enqueued":4174,"connectionErrors":0,"peak_in_use":10,"active_at_end":0},"event_loop_delay_ms":{"mean":30.07,"p95":31.2,"max":36.57}}
```

## Acceptance reading

- The venue-realistic 1-agent and 5-agent tiers passed every hard bar: p95 was 7 ms, pool enqueueing and connection errors were zero, peak pool use was 1, active connections at exit were zero, and event-loop p95 delay stayed below 32 ms.
- The 10-agent and 50-agent headroom tiers completed without request failure, connection error, or leak. The 50-agent run saturated the configured ten-connection pool without enqueueing.
- The 100-agent stress tier also completed every request without connection error or leak. It saturated the ten-connection pool and queued 4,174 acquisitions; this is expected headroom pressure, not a venue capacity promise.
- No product polling interval or pool setting was changed from these measurements.
