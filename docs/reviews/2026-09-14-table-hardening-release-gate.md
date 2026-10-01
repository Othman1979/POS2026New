# Table hardening Release gate

PR: https://github.com/skelvar/posappv4/pull/16

The first full GitHub gate at `f025a4c7` ran all four application shards plus Windows installer and spooler checks. Application totals were 4,946 passed and two failed; Windows installer and spooler passed. Devin reported no issues, and Codex code/security reviews completed without findings or review threads. The failed gate was not bypassed and branch protection remained enabled.

The two failures were reproduced locally before editing:

- `installerBaseline.test.js` retained a 76-table expectation after `deleted` made the current schema 77 tables. The real fresh installer/schema validator already passed; the count now includes the archive explicitly.
- `posTerminalOwnership.spec.js` expected the old Arabic Join wording for combining bills. Independent seating intentionally uses **ضم**, documented in the accepted seating controls and exercised in the browser. The test now matches that seating action.

The installer test also now claims a generated loopback database with `CREATE DATABASE` and drops only a database it successfully created, retaining the real bootstrap, schema validation and repeated startup checks. It no longer preemptively drops a fixed test database. No application logic, workflow gate, schema or production translation was changed for these corrections.

Local RED/GREEN evidence: `scratch/pr16-fixtures-{red,green}.{log,json}`. Initial GitHub logs: `scratch/pr16-application-{1,2,3,4}.log`. The complete Release gate must pass on the updated PR before merge.
