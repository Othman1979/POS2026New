# Go Gemini order gateway

This removable Go process connects Gemini Live to POSApp's provider-neutral order-intake API. It can browse the current menu in bounded pages, search selected products, look up customers, obtain server-authoritative quotes, and create a **held order for cashier review** after explicit customer confirmation. It cannot take payment, check out, print, select a table or printer, or fire the kitchen.

The POSApp and Gemini API keys stay in the Go process. The embedded loopback browser receives neither key. A local SQLite outbox owns confirmed order delivery independently of the model, so a timeout, model disconnect, or process restart cannot silently duplicate or discard a confirmed request.

## Configure

Go 1.25 or newer is needed to build the gateway. The built Windows executable has no Node.js gateway runtime and no separate UI files; the local browser assets are embedded in it.

```powershell
cd C:\xampp\htdocs\posapp
Copy-Item integrations\gemini-order-gateway\gateway.env.example integrations\gemini-order-gateway\gateway.env
npm run gateway:build
```

Fill `gateway.env` with the raw `ORDER_INTAKE_API_KEY` generated for the enabled POSApp intake API and a `GEMINI_API_KEY`. The env file is ignored by Git. By default, the SQLite outbox uses the current Windows user's Local AppData directory. `ORDER_GATEWAY_OUTBOX_PATH` may override it only with an equally protected local path.

`npm run gateway:build` finds Go from `POSAPP_GO_EXE`, `PATH`, or the verified Codex portable runtime cache. The resulting executable is ignored by Git. Voice and simulation commands rebuild when local source is newer and Go is available; a packaged customer runtime still runs its existing executable without Go.

## Test with local voice

From the repository root, start POSApp and the Go voice gateway together:

```powershell
npm run gateway:voice:local
```

The command verifies the configured loopback URL is specifically a healthy POSApp instance, reuses it when available, or starts `server.js` on that URL's port. It then prints the local browser URL, normally `http://127.0.0.1:3199/`. Keep the terminal open and press Ctrl+C to stop. If the POSApp child exits, the gateway also stops.

Open the printed URL in Chrome or Edge, choose English or Jordanian Arabic, allow microphone access, and start the session. Hold the center button while speaking and release it at the end of each turn. Each press/release is an explicit Gemini activity boundary, so confirmation cannot come from trailing audio in the quote request. Pressing while Gemini speaks clears queued browser audio for interruption.

The browser streams 16 kHz PCM and plays native 24 kHz Gemini audio. It does not persist audio. It displays finalized input transcription and first-transcript/first-audio timing. The HTTP/WebSocket server binds only to `127.0.0.1`, rejects cross-origin sockets, disables WebSocket compression, bounds control messages, and enforces `VOICE_GATEWAY_MAX_SESSIONS` before opening more Gemini sessions.

Gemini session resumption is enabled. Sends on one Live session are serialized, and repeated function-call ids reuse the original result so reconnecting cannot execute the same POS operation twice. The SQLite outbox remains the authority for confirmed order recovery even when the voice session cannot resume.

For a reviewed remote HTTPS POS target, start `gateway:voice` with `--allow-remote-submit`. Without that explicit flag, the gateway refuses remote recovery and hold creation.

## UCM6301 connection probe

The [UCM630x SIP extension](https://documentation.grandstream.com/knowledge-base/ucm630x-series-user-manual/) path is the first phone integration slice. Create a **dedicated test extension** on the PBX, restricted to internal calls and the gateway PC's LAN address. In the ignored `gateway.env`, set `UCM_SIP_SERVER` to the PBX's private IPv4 address and SIP port, `UCM_SIP_LISTEN` to this PC's private IPv4 address and an unused UDP port, plus `UCM_SIP_EXTENSION`, `UCM_SIP_AUTH_ID` (only if different from the extension), and `UCM_SIP_PASSWORD`. Do not copy the SIP password into source control or a command line.

```powershell
npm run gateway:ucm:probe
```

The probe uses SIP digest authentication, verifies that the UCM accepts the registration, and immediately unregisters. It binds only the configured LAN address, refuses public or wildcard SIP destinations, and responds unavailable to an incoming call during the probe. It does **not** route audio to Gemini, create an order, or transfer a call. Leave the restaurant's inbound route unchanged; a later SIP/RTP call adapter must pass real extension, audio, caller-ID, hangup, transfer and concurrent-call tests before live routing. The UCM also documents an [HTTPS API for inbound call transfer](https://documentation.grandstream.com/knowledge-base/https-api/), but that API does not supply call audio and is not required for this probe.

## Deterministic POS simulation

With POSApp already running, request a real quote without using Gemini:

```powershell
npm run gateway:simulate -- --query burger
```

Create one local held test order:

```powershell
npm run gateway:simulate -- --query burger --submit
```

The result must appear in Held Orders with `kitchen_fired=false`; no sale or print job is created. Remote creation and recovery require the explicit `--allow-remote-submit` flag.

Recover durable pending attempts after a simulated restart:

```powershell
npm run gateway:simulate -- --recover-only
```

## Delivery rules

- Draft and quote changes are allowed only before confirmation.
- The exact `{draft, quote_token, confirmed:true}` body becomes durable before the create request starts.
- On a timeout or server failure, the gateway looks up the same request id before replaying the exact saved body.
- A found replay is definitive. If lookup is also unavailable, the record stays pending for later recovery.
- Confirmed delivery uses the process lifetime rather than the browser/media lifetime. A bounded background worker revisits unresolved rows every 15 seconds while the process remains active.
- Authentication, validation, and idempotency conflicts become blocked and are not retried automatically.
- A changed or expired quote requires a new readback and a new customer turn before confirmation.
- `handoff_locked` prevents an uncertain create from being submitted by the gateway again; recovery performs lookup only.
- Gemini Live resumes only between complete turns with a fresh valid handle. An interrupted turn or non-resumable update ends the voice session visibly; confirmed POS delivery still reconciles from the durable outbox.

The outbox contains customer contact details and the exact confirmed order body. Keep it in the default per-user directory or a location with equivalent access controls, never sync it to source control, and apply an operational retention policy. The gateway stores no audio or model conversation history.

The browser adapter proves the model, tool, durability, and audio path without Grandstream. The UCM probe checks LAN SIP credentials only. A later SIP/RTP call adapter can reuse the Go POS client, tools, and outbox without changing POSApp's API.

The gateway uses Google's official [`google.golang.org/genai`](https://pkg.go.dev/google.golang.org/genai) Go SDK. Gemini Live is a preview API; SDK/model upgrades must rerun the Live protocol, reconnect, tool-deduplication, and real POS integration checks.

## Verify

```powershell
npm run gateway:test
npm run test:isolated -- backend/tests/integration/geminiOrderGateway.test.js
```

The Go tests cover config, bounded HTTP, SQLite transitions, ambiguous recovery, tool safety, Live events/reconnect, and the loopback WebSocket server. The isolated test builds the Windows executable and drives it through the real Express/MySQL order-intake API, including a lost create response and a real price-change requote.
