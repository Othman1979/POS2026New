---
name: jofotara-invoice-integration
description: Modify POSApp JoFotara invoice XML, submission outcomes, or credit-note handling using its existing document lifecycle.
---

# JoFotara in POSApp

This project skill describes the existing POS integration. Paths below are relative to the repository root. Read files relevant to the change, not every reference by default.

| Change | Source and focused tests |
|---|---|
| HTTP response, acceptance, QR, uncertain result | `backend/services/JofotaraClient.js`, `backend/tests/unit/jofotaraClient.test.js` |
| Snapshot, quantity, tax, XML, partial credit note | `backend/services/JofotaraXmlBuilder.js`, `backend/tests/unit/jofotaraXmlBuilder.test.js` |
| Document creation, identity, retry, persistence | `backend/services/JofotaraService.js`, `backend/tests/integration/jofotara.test.js` |
| Scheduling and recovery | `backend/services/JofotaraOperationsRunner.js`, `backend/tests/unit/jofotaraOperationsRunner.test.js` |
| Archive behavior | `backend/services/JofotaraXmlArchive.js` and its callers |

## Preserve the document contract

- Keep the UUID, request XML, and legal snapshot associated with the persisted document. Do not mint a new identity for each HTTP attempt. Accepted documents return their stored result; uncertain/submitting states require the existing recovery handling.
- HTTP 200 alone is insufficient. The current client requires explicit success, a non-empty `EINV_QR`, and no explicit rejection. Ambiguous responses stay `unknown`; preserve its tested token rules unless changing the contract with evidence.
- The current builder serializes quantities and amounts to six decimal places and rates to two. Preserve fractional quantities such as `0.125`; do not import two-decimal quantity formatting from historical examples.
- Credit notes use the accepted original's persisted identity and snapshot. Preserve existing partial-return limits, tax categories, and sales/income profile handling.
- Preserve credential redaction and existing endpoint/transport handling. Code edits and local tests do not authorize a live government submission.

For a proposed protocol change, check current authoritative documentation and existing fixtures before changing behavior. Examples from other integrations are not proof of current government requirements.
