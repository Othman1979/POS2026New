# Deferred diagnosis: long thermal reports print raster bytes as characters

- Status: Universal bounded-raster mitigation implemented; affected hardware verification pending
- Recorded: 2026-08-14
- Scope: Windows spooler printing of long X, Z, audit, and category-items reports
- Privacy: Customer identity and production data are intentionally omitted

## Symptom

One installation prints customer receipts and kitchen tickets normally, while longer reports print a long stream of Chinese-looking or random characters.

The supplied photo shows structured character noise across the paper rather than damaged Arabic shaping. This is consistent with raster bitmap bytes being interpreted as printable text after the printer rejects or loses synchronization with the raster command.

## Repository evidence

- `pos-spooler-printer/server.js` screenshots the complete `#receipt-body` at its full rendered height and sends it through `printer.raster(image, 'normal')` as one image.
- The same file writes the complete generated buffer in one operation for both network and Windows printer paths. It does not split tall images into raster bands.
- The bundled `escpos` implementation encodes raster images using the legacy `GS v 0` command and writes the complete width, height, and bitmap payload as one command.
- At the spooler's 576-dot render width, every vertical pixel row requires 72 bytes. A 5,000-pixel report therefore produces roughly 360 KB of bitmap data before command overhead.
- X/Z, audit, and category-items reports can be substantially taller than ordinary receipts and kitchen tickets.
- The backend's compiled print-document path applies to receipt and kitchen jobs, while these report types still reach the spooler's report rendering branches.
- Existing report-rendering tests mock the screenshot bounding box as one pixel high, so they do not exercise realistic raster height or command size.

## High-confidence diagnosis

The affected printer model, firmware, or ESC/POS emulation likely rejects or mishandles a raster command whose vertical size or payload exceeds its supported limit. Once the command is rejected or parsing falls out of sync, the remaining bitmap bytes are printed as text-like glyphs.

This explains why:

- short receipts and kitchen tickets print normally on the same installation;
- long reports fail;
- other customers with different printer hardware or firmware do not reproduce the problem.

This is not yet model-specific proof because the affected printer model and a controlled short-versus-long report result have not been collected.

## Ruled out by the current evidence

- Arabic font or text encoding failure: the spooler renders HTML into a bitmap before printing.
- Database or JSON corruption: the output resembles raw binary payload interpretation, not corrupted report fields.
- A general Windows code-page issue: shorter bitmap-based jobs print normally.
- Printer-role routing as the primary cause: report dispatch resolves through the receipt-printer role, and the reported customer receipt works.

## Evidence still required from the affected installation

Collect only the following from the affected installation:

1. Printer manufacturer and exact model from its label.
2. Whether the spooler reaches it through a Windows printer/share or direct network address.
3. Installed spooler version.
4. The relevant section of `C:\ProgramData\POS-Spooler\logs\spooler-service.out.log`, with customer data removed.
5. A controlled comparison between a nearly empty shift report and a populated long report.

If the short report works and the long report fails, the height/payload limit is effectively confirmed.

## Implemented universal mitigation

The shared raster-output seam now converts screenshot RGBA bytes directly into sequential `GS v 0` commands capped at 256 rows per band. Alerting, cutting, transport, queue acknowledgement, retry behavior, and durable idempotency remain at the job level.

The implementation also removes the second PNG encode/decode and object-heavy `escpos.Image` conversion, which reduces CPU and memory pressure on low-end terminals. Focused tests reconstruct a 576×5,000 raster with no missing or duplicated row and prove that a 513-row job emits 256 + 256 + 1 rows with one alert sequence and one cut.

This is a universal compatibility mitigation, not proof of the original customer-specific root cause. Keep the linked issue open until the affected printer passes a controlled short/long physical print comparison.

Do not add customer-specific conditions or printer-model configuration unless the remaining evidence proves that a universal conservative band height is insufficient.

## Acceptance criteria

- A realistically tall report prints readable content in the correct order with no gaps or duplicated rows.
- Short customer receipts and kitchen tickets remain unchanged.
- One queued report still produces one physical report, one alert sequence, one cut, and one acknowledgement.
- Network and Windows output paths preserve the same ordered raster bands.
- Retry and durable queue idempotency remain unchanged.
- A focused regression test uses a realistic multi-thousand-pixel report height and proves that no raster command exceeds the chosen band height.

## Vendor references

- Epson documents `GS v 0` as an obsolete raster command with model-dependent supported dimensions: <https://download4.epson.biz/sec_pubs/pos/reference_en/escpos/gs_lv_0.html>
- Epson documents repeated graphics commands as the way to print beyond a command's vertical limit: <https://download4.epson.biz/sec_pubs/pos/reference_en/escpos/gs_lparen_cl_fn112.html>
- Epson's graphics limits vary by model and include finite vertical-area limits: <https://download4.epson.biz/sec_pubs/pos/reference_en/escpos/gs_lparen_cl_fn69.html>

## Remaining decision

Do not add printer-model conditions unless the affected installation still fails after receiving the runtime spooler update and the model-specific evidence above proves a narrower compatibility requirement.
