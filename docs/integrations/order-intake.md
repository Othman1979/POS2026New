# Provider-neutral order intake

This integration lets a trusted external assistant build a server-priced order and place it in the existing phone-order queue. It does not check out an order, take payment, choose a printer, print a kitchen ticket, or create a sale. A cashier still reviews and completes the held order through the normal POS workflow.

The API is disabled by default and has no provider SDK. OpenAI, Gemini, a local model, a deterministic test program, or a human-operated gateway can use the same OpenAPI 3.0 contract in [`order-intake.openapi.yaml`](order-intake.openapi.yaml).

## Safety boundary

- The caller may choose active order types, products, quantities, approved modifiers, bundle removals/notes, customer details, and free-text notes.
- The server owns product availability, stock checks, prices, taxes, modifier prices, bundle contents, totals, and the actor identity.
- The caller cannot submit discounts, prices, tax values, payment data, table IDs, printer IDs, or checkout instructions. Unknown fields are rejected.
- Creating a hold requires a fresh signed quote and the literal `confirmed: true`. If catalog or pricing data changes, the API returns `ORDER_INTAKE_REQUOTE_REQUIRED` with a replacement quote. The caller must read the new total to the customer and ask for confirmation again.
- A successful create always uses `dispatch_policy: hold_only`, writes `kitchen_fired=0`, and produces no print job. This avoids sending an unreviewed machine order directly to production.
- Reusing one `external_request_id` with the same request safely replays the first result. The non-PII result remains durable after the held row is completed or canceled, so a delayed retry cannot recreate it; such a replay returns `active: false`. Reusing the ID with different content fails with `ORDER_INTAKE_IDEMPOTENCY_CONFLICT`.
- The dedicated actor must be an active `call_center` user. It gains no browser session, shift, checkout, table, refund, print, or manager authority.

The POS server cannot prove that a customer spoke a confirmation. The calling assistant or gateway is responsible for setting `confirmed: true` only after it presented the returned quote and received an explicit confirmation.

The recovery endpoint `GET /api/order-intake/v1/requests/{external_request_id}` never creates or changes an order. It returns the durable result when a create committed and `request: null` when no committed result is visible. A found result is definitive. A null result is not definitive while an older create request may still be executing, so it must not by itself authorize a second manual order.

## Enable it

Create a dedicated active call-center user in POSApp and note its numeric database `id`. Do not reuse a cashier, manager, administrator, or programmer account.

Generate credentials locally:

```powershell
npm run order-intake:key
```

The command prints one raw Bearer key, its SHA-256 digest, and a separate quote-signing secret. Store the raw Bearer key only in the calling gateway or Action secret. POSApp stores only its digest. Store the quote secret only in the POSApp environment.

Configure the server and restart it:

```dotenv
ORDER_INTAKE_ENABLED=true
ENFORCE_HTTPS=true
ORDER_INTAKE_CLIENT_ID=phone-assistant
ORDER_INTAKE_API_KEY_SHA256=<sha256-from-generator>
ORDER_INTAKE_QUOTE_SECRET=<quote-secret-from-generator>
ORDER_INTAKE_ACTOR_USER_ID=<dedicated-call-center-user-id>
ORDER_INTAKE_QUOTE_TTL_SECONDS=300
ORDER_INTAKE_RATE_LIMIT_MAX=120
ORDER_INTAKE_CREATE_RATE_LIMIT_MAX=30
ORDER_INTAKE_ACTIVE_HOLD_LIMIT=200
```

`ORDER_INTAKE_CLIENT_ID` identifies the one configured integration in held-order metadata and logs. Use letters, digits, `_`, or `-`. This single Bearer key grants access to every intake endpoint, including private customer lookup and held-order creation, so give it only to one trusted server-side gateway. Production intake refuses to start unless `ENFORCE_HTTPS=true`. Rate settings are loaded when the POS process starts. The active-hold limit is clamped to 20-5000 and bounds how much uncompleted work this integration can add to the cashier queue. Human call-center users keep their existing independent limit. Intake JSON bodies are capped at 2 MB before authentication and at most eight are parsed concurrently.

Health-check with the raw key:

```powershell
$headers = @{ Authorization = 'Bearer <raw-key>' }
Invoke-RestMethod -Headers $headers https://your-pos.example/api/order-intake/v1/status
```

## Test without an AI model

Start POSApp normally, then run a quote-only simulation. It reads active order types, searches the live catalog, and requests an authoritative quote without writing an order:

```powershell
$env:ORDER_INTAKE_API_KEY = '<raw-key>'
npm run order-intake:simulate -- --query=burger
Remove-Item Env:ORDER_INTAKE_API_KEY
```

Create one held test order on a local database:

```powershell
$env:ORDER_INTAKE_API_KEY = '<raw-key>'
npm run order-intake:simulate -- --query=burger --submit
Remove-Item Env:ORDER_INTAKE_API_KEY
```

Verify that a lost response can be retried without creating a second hold:

```powershell
$env:ORDER_INTAKE_API_KEY = '<raw-key>'
npm run order-intake:simulate -- --query=burger --submit --verify-replay
Remove-Item Env:ORDER_INTAKE_API_KEY
```

The simulator refuses to submit to a non-loopback host unless `--allow-remote-submit` is present. If the selected product requires modifiers, pass `--product-id=<id>` for a simple product. Confirm the resulting `Phone #...` entry in the normal cashier Held Orders screen; it must be marked as not sent to the kitchen.

The automated workflow simulation is:

```powershell
npm run test:isolated -- orderIntake --reporter=default
```

It verifies authentication, catalog and customer reads, price authority, required modifiers, bundle hydration, quote expiry/tamper protection, confirmation, idempotent concurrency, stale-price re-quote, queue limits, no checkout, and no print job.

## Local Gemini gateway

### Staff-maintained dish information

In **Inventory → Add Product / Edit Product → Details**, the optional **Customer information** field stores customer-facing dish facts and included sides in `products.customer_info` (maximum 1200 characters). No additional table, copy of the catalog, or AI lookup request is needed. Existing product-management permissions control editing; a call-center role alone does not grant inventory access. The former `/ai-catalog` page redirects to Inventory.

For example: “Served with mutabbal, garlic sauce and our beetroot sauce.” Keep prices, availability and paid extras in their normal product fields. Empty information means unknown. The editor loads the existing field with the product, omits it when unchanged, and protects a changed description against concurrent edits. Partial API updates preserve an omitted field; an empty value clears it. AI Bearer credentials cannot edit products. Search reads the description in the same fresh product query; the regular POS and public menu payloads remain unchanged. Replacing the catalog through a destructive import deletes product rows and their descriptions; replacement IDs need new reviewed information.

The agent must search before describing a selected dish, keep paid extras as real catalog selections, distinguish item preparation notes from order/delivery notes, and read the authoritative quote back before confirmation. If no sellable search result exists, search also reports up to three explicitly disabled matches in `unavailable_products`; these are never orderable. Availability is still rechecked at quote and submission. A definitive availability rejection permits a corrected draft and requires a fresh quote and customer confirmation. An uncertain network outcome retains the original pending submission and must be reconciled, never replaced.

The `request_staff` tool marks this live session as staff-required and blocks further order tools. Complaints, refunds, cancellations, already-submitted order changes and unrelated requests use this path. The local adapter has no phone-transfer connection: the returned result and browser status say so; it must never claim that a human was notified or a transfer completed. This is a conversation guard, not a replacement for durable pending-order recovery. No calls are recorded and no automatic learning is enabled.

The removable Go gateway in [`integrations/gemini-order-gateway`](../../integrations/gemini-order-gateway/README.md) adds a local SQLite outbox and Gemini Live adapter without placing a provider SDK in the POSApp server. Its deterministic simulator exercises the same durable path without a model key; the Live adapter uses `GEMINI_API_KEY` only from the gateway process environment.

```powershell
Copy-Item integrations\gemini-order-gateway\gateway.env.example integrations\gemini-order-gateway\gateway.env
npm run gateway:build
npm run gateway:simulate -- --query burger
npm run gateway:voice:local
```

Connecting `gateway:voice` to a reviewed remote HTTPS POS requires the explicit `--allow-remote-submit` flag; remote writes and recovery otherwise fail closed.

The foreground launcher keeps POSApp and the Go voice process together and reports if either exits. The executable embeds a loopback-only push-to-talk page with explicit English and Jordanian Arabic session choices. The browser receives neither API key, streams short 16 kHz PCM chunks, plays native 24 kHz Gemini audio, and does not record audio. Button press/release maps to explicit Gemini activity boundaries, bypassing server-side silence delay. The gateway injects the stable external request id and keeps quote tokens out of model tool results. It saves the exact confirmed body before network delivery, reconciles ambiguous outcomes through the request lookup endpoint, and never turns a re-quote into a new confirmation. Grandstream/UCM audio and RTP/SIP transport remain outside this local adapter.

## Connection-loss behavior

The network cannot provide true exactly-once delivery: after a timeout, a caller cannot know whether the server committed just before the response disappeared. The integration therefore uses at-least-once delivery with one durable idempotency identity. Every retry for one call must send the same `external_request_id` and the same normalized draft.

| Failure point | POSApp state | Gateway action |
| --- | --- | --- |
| Connection closes before the complete JSON body arrives | Nothing is written | Retry the same operation if the call is still active. |
| Catalog, customer lookup, or quote response is lost | Nothing is written | Retry; these operations are read-only. |
| Create request never reaches POSApp | Nothing is written | Retry the identical confirmed request. |
| Create commits but its response is lost | One held order and one replay row exist atomically | Retry the identical confirmed request; POSApp returns the first result with `replay: true`. |
| Database fails between held-order and replay-row inserts | The transaction rolls back both rows | Retry the identical confirmed request. |
| Socket notification fails after commit | The hold remains committed | Treat the HTTP result or replay as authority; cashier refresh/reconnect discovers the hold. |
| Price, tax, modifier, bundle, or availability changes | No hold is created | Read the replacement quote and ask the customer to confirm again. |
| Credentials or actor configuration fails | No hold is created | Do not loop; transfer to a human and alert operations. |
| Capacity or repeated transient failures persist before confirmation | No hold is created | Transfer to a human with the local structured draft. |
| Connectivity remains uncertain after confirmation | The create outcome may still be unknown | Keep the durable incident under gateway ownership; do not let a human independently re-enter it. Reconcile when POSApp is reachable, then have staff call the customer if needed. |

The confirmed create body remains replayable even after its quote token expires if the first attempt already committed: POSApp looks up the durable request identity before validating the old token. If no first commit exists, the expired token is rejected and a fresh quote plus confirmation is required.

### Gateway durability rules

The gateway must own order state independently of Gemini. Do not keep the only copy in model conversation history.

1. Generate one cryptographically random `external_request_id` when a call begins.
2. Persist the complete structured draft before requesting its authoritative quote and on every subsequent re-quote.
3. Before sending a confirmed create, persist an outbox record containing the exact draft, quote token, confirmation time, and state `pending`.
4. Mark it `completed` only after a valid POS response or an idempotent replay identifies the held order.
5. On timeout, non-JSON response, process restart, or unknown outcome, call the read-only request lookup first. If it is absent, wait for any older create attempt to settle and retry the exact outbox payload while the gateway still owns the incident. Never generate a new request ID for a retry.
6. Never automatically retry validation errors, authentication errors, idempotency conflicts, or `ORDER_INTAKE_REQUOTE_REQUIRED`.
7. Bound transient retries with short exponential backoff and jitter. Before confirmation, persistent failure may transfer to a human. After confirmation, retain an unresolved incident for reconciliation and do not start an independent manual order.
8. Store API keys separately from the outbox. Redact customer data and credentials from logs.

If a later staff workflow explicitly assumes responsibility for an unknown confirmed create, move the outbox row to `handoff_locked`, cancel all gateway retry timers, and wait for every in-flight HTTP attempt to settle. Continue polling the read-only lookup through a bounded quiet period. Staff must search Phone Orders by the customer's phone number and must not enter another order until the gateway reports a definitive committed result or operations explicitly resolve the incident. A future staff recovery screen can make this handoff convenient; until then, keeping the incident under gateway ownership is safer.

A small local SQLite outbox is sufficient for one gateway. It avoids a queue service and survives a gateway process restart. Rows should contain the minimum call state required for recovery and follow the restaurant's customer-data retention policy.

### Voice and telephone disconnects

- If Gemini disconnects between complete turns with a fresh resumable handle, resume the conversation. If a turn, tool response, or handle is uncertain, end the voice session visibly instead of silently continuing from older state. A quoted draft remains in the outbox; collect an incomplete conversation again without creating a hold.
- If Gemini disconnects after the customer confirmed, finish or reconcile the pending POS create from the durable outbox before reporting failure.
- If the telephone call ends before confirmation, abandon the draft without creating a hold.
- If the telephone call ends after confirmation while create is pending, continue reconciliation from the durable outbox. If the outcome remains unknown, create an operations incident and arrange a callback after reconciliation; do not silently discard it or let a separate manual order race it.
- When the caller interrupts Gemini, immediately discard queued model audio. This affects speech playback only and must not mutate the structured draft or confirmation state.

## Connect a model later

Give the model or gateway the OpenAPI file and these behavioral rules:

1. Search the catalog; never invent a product, modifier, or price.
2. Build a draft with a unique stable `external_request_id` for the call.
3. Request a quote and read back its authoritative items and total. Repeat the customer details and delivery time from the unchanged local draft.
4. Ask for explicit confirmation.
5. Send the unchanged draft, returned `quote_token`, and `confirmed: true`.
6. On `ORDER_INTAKE_REQUOTE_REQUIRED`, read the replacement quote and confirm again.
7. On ambiguity, unavailability, capacity, or repeated validation errors, transfer to a human.

Use HTTP Bearer authentication in the tool configuration. Do not put the key in prompts, query strings, browser local storage, source control, or logs. Rotate it by generating a new key, replacing its hash on POSApp and the raw secret in the caller, then restarting both sides.

As of September 2026, OpenAI documents that custom GPT Actions are unavailable in ChatGPT Voice mode. OpenAI also says new custom GPT creation is unavailable on personal accounts; an existing eligible text-mode GPT Action can use this OpenAPI 3.0 contract where Actions are available, but it still needs to be imported and tested in Preview for the target account. A ChatGPT subscription does not provide OpenAI API usage. For a real phone call, use a server-side voice provider or model adapter that invokes this same API. Gemini function calling and local tool-capable models can do the same through a small adapter; they do not need POS-specific backend code.

## Idempotency retention

`order_intake_requests` is a small, non-PII replay ledger. It intentionally survives held-order completion, cancellation, and the operational data reset so delayed retries cannot recreate an order. The first release of this integration creates the ledger before any intake endpoint can be enabled, so there are no older machine-created holds to backfill.

Keep replay rows for at least 180 days and longer than the maximum retry lifetime of every connected gateway. If storage policy requires cleanup, first stop intake callers, verify they will never retry or reuse IDs from the expired period, then delete old rows in bounded maintenance batches:

```sql
DELETE FROM order_intake_requests
WHERE created_at < DATE_SUB(NOW(), INTERVAL 180 DAY)
ORDER BY created_at
LIMIT 1000;
```

Repeat the batch until no row is deleted, then resume callers. Purging a row removes POSApp's replay protection for that old `external_request_id`, so caller-generated IDs must remain globally unique and must never be reused. The `created_at` index keeps the bounded purge proportional to the expired range; POSApp does not run this destructive cleanup automatically.

## Disable or remove it

Before disabling, stop new gateway calls and reconcile every `pending` or unknown outbox row. Then set `ORDER_INTAKE_ENABLED=false` and restart the server to make every endpoint return 404. Removing `backend/routes/orderIntake.js`, `backend/modules/orderIntake/`, and its `server.js` parser/gate/mount removes the external runtime. Keep `HeldOrderCanonicalizer.js`; it is the existing human held-order pricing logic extracted into a shared service. The small `order_intake_requests` table contains request hashes, held IDs, totals, and replay results without customer identity; retain it while delayed retries may exist, then remove it with a separate reviewed migration if the feature is permanently retired. The POSApp server contains no provider SDK, external session store, or recovery worker; the removable Go gateway owns its bounded local recovery loop. Existing held orders remain ordinary call-center holds and can be completed or canceled normally.

## References

- [OpenAI: Configuring actions in GPTs](https://help.openai.com/en/articles/9442513-configuring-actions-in-gpts)
- [OpenAI: ChatGPT Voice](https://help.openai.com/en/articles/20001274)
- [OpenAI: Voice Mode FAQ](https://help.openai.com/en/articles/8400625-voice-mode-faq)
- [OpenAI: GPTs in ChatGPT](https://help.openai.com/en/articles/8554407-gpts-in-chatgpt)
- [OpenAI: Realtime server controls](https://developers.openai.com/api/docs/guides/voice-server-controls)
- [Google Gemini: Function calling](https://ai.google.dev/gemini-api/docs/function-calling)
- [OWASP REST Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html)
- [OWASP API4: Unrestricted Resource Consumption](https://api-security.owasp.org/editions/2023/en/0xa4-unrestricted-resource-consumption/)
