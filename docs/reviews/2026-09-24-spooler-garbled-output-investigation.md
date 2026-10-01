# Garbled receipt investigation — 2026-09-24

## Incident and current conclusion

The supplied photo shows a recognizable Arabic/English header and invoice 16469 followed by a long stream of small random glyphs. The user reports intermittent busy-period failures at one restaurant, affecting kitchen and customer printers, with both direct-IP and Windows printer configurations and two terminals. Exact printer models, physical routing and installed spooler build are not yet available.

The appearance is consistent with raster payload bytes being interpreted as text after the printer command stream loses its expected state. It does not establish a Chromium font/rendering failure. There is a confirmed software cancellation hazard in the Windows path and additional shared-endpoint/recovery risks worth checking against this incident. The customer-specific cause is not yet proved.

Research was read-only for application source. No printer, customer database, service restart or deployment was used. The checkout is currently codex/pos-tables-hot-paths; unrelated changes were preserved.

## Why a rendered-image pipeline can produce these characters

The reviewed Chromium pipeline screenshots the receipt, converts pixels into ESC/POS raster bands, saves the complete artifact, and sends its bytes. The raw printer receives image commands, not the receipt's Arabic strings. The current Typst path uses the same raster encoder and transports; changing renderer alone cannot be treated as a fix for interrupted or conflicting sends.

Both the working tree and pre-Typst release commit 0aab81ea310af29b96df39dc81d5f67bdb2c237a (spooler 1.2.21, 2026-09-16) use 576-dot raster output with 256-row bands. GS v 0 specifies image dimensions and the following byte count. Epson documents that the command depends on beginning-of-line/empty print-buffer state; otherwise following data can be handled as ordinary data. This supports the interpretation of the photo but does not identify the event that disturbed this customer's stream. [Epson command reference](https://download4.epson.biz/sec_pubs/pos/reference_en/escpos/gs_lv_0.html)

References: pos-spooler-printer/thermal-raster.js:46; v2/artifact-renderer.js:673; v2/typst-renderer.js:311. The reviewed Chromium writer begins with image data and has no per-job initialization/recovery handshake. Simply inserting a reset is not proven safe after an interrupted binary payload: the device may still be expecting image bytes.

## Confirmed Windows cancellation hazard

At pos-spooler-printer/windows-helper/PosSpoolerPlatform.cs:340:

    if (SetJob(printer, jobId, 0, IntPtr.Zero, JOB_CONTROL_DELETE) && !printingSeen)
        return "stuck_deleted";
    return "drain_unknown";

SetJob runs before the printingSeen check. On expiry of the drain wait, the code requests deletion even if it observed JOB_STATUS_PRINTING. In that case it returns drain_unknown after requesting the deletion. The default drain budget is 10 seconds. The older 1.2.21 helper has the same behavior.

This is a software policy/correctness concern for a busy queue: expiry of an observation budget can cancel a job that is still printing. The historical drain design also specified cancellation on expiry, so do not assume this is merely a new Typst regression or that swapping operands completes the recovery design. Even a job whose PRINTING flag was never sampled may already have sent bytes.

I extracted the actual WaitForLocalQueueDrain method from the old and current source, compiled each in a C# harness, and substituted controlled GetJob/SetJob APIs. No actual Windows printer API was called. Both versions produced:

| Reported status | Delete calls after wait | Result |
| --- | ---: | --- |
| PRINTING | 1 | drain_unknown |
| Queued | 1 | stuck_deleted |
| PRINTED | 0 | drained |

Evidence: scratch/spooler-drain-delete-probe.ps1 and adjacent JSON. This proves the deletion request in the supplied state, not that a physical printer was interrupted in this incident.

The helper's separate write deadline also requests cancellation, so the eventual fix must review both submission and drain-timeout policy and keep uncertain outcomes from being automatically reprinted. The direct-IP transport does not execute this Windows code.

## Two additional verified scheduling behaviors

Using the actual old/current worker modules with a mock transport:

| Scenario | Observation |
| --- | --- |
| Two jobs, same printer_id | Sends are serialized |
| Two printer_ids, same physical IP/port | Two sends can overlap |
| First job fails after send started, outcome uncertain | The next job on that printer is dispatched |

Evidence: scratch/spooler-garbled-output-probe.cjs and adjacent JSON. This establishes scheduling behavior only; it does not prove TCP streams are interleaved by a particular printer.

The queue is keyed by printer_id in v2/printer-workers.js:209,275. Admin printer creation validates addresses but does not reject duplicate physical endpoints in backend/routes/admin/printers.js:112–133. A direct-IP record and a Windows alias for the same device can also bypass a simple endpoint comparison. Server agent ownership protects configured printer records; it is not a universal physical-device lock across aliases, other software and machines. Two terminals with two genuinely separate printers do not inherently collide.

Workers record uncertain sends at printer-workers.js:138, then continue the lane at line 219. If a partial raster was sent, a following job may meet an unexpected device parser state. This is a recovery risk that requires targeted testing; an uncertain result alone does not prove the stream was partial.

## Checks completed and their limits

- Current thermal-raster, v2-printer-workers and v2-printer-transports tests passed. The printed EACCES/ENOSPC messages are intentional injected test cases.
- The old/current queue characterization and extracted C# drain-method experiments passed their assertions, exposing the behaviors above.
- Inspected byte-count encoding, immutable artifact verification and partial WritePrinter handling. Existing hash verification checks the local artifact, not physical paper completion.
- No malformed artifact from invoice 16469, customer transport log or packet capture has been inspected. No physical corruption was reproduced. The exact customer version is unconfirmed.

## Next evidence and remediation priorities

1. Obtain the installed version, printer routing records and job record/artifact for invoice 16469 plus the immediately preceding job on the affected printer. Default installed locations are C:/ProgramData/POS-Spooler/state/jobs/{active,archive}, state/artifacts, and logs/spooler-service.err.log. SPOOLER_STATE_DIR can override the state path. Current retention is 14 days, subject to installed version/cleanup.
2. Decode the saved artifact to an image and validate every raster header/length. A correct decoded artifact shifts investigation downstream; malformed bytes require encoder/artifact fixes before transport tuning.
3. Look for WINspool_DRAIN_UNKNOWN, WINspool_JOB_STUCK, WINspool_DEADLINE_EXCEEDED, PRINTER_WRITE_TIMEOUT and PRINTER_STREAM_TIMEOUT around the incident. Correlate by queue ID and time, not invoice number alone.
4. Fix the confirmed active-job cancellation hazard with focused helper/worker tests. Preserve uncertain-send protection; neither auto-reprinting nor blindly continuing/reinitializing every device is a safe substitute for a defined recovery policy.
5. If shared physical endpoints are confirmed, enforce one sending owner and serialize by physical destination where it can be identified. Verify terminal receipt routing stays separate and kitchen jobs retain priority.

Do not promise that a renderer switch, a global sleep, larger timeouts or a replacement printer fixes this incident. Correlate the confirmed software risks with field evidence first.
