const ENDPOINT = 'https://backend.jofotara.gov.jo/core/invoices/';

function walk(value, visitor, depth = 0) {
    if (depth > 12 || value == null) return;
    if (Array.isArray(value)) return value.forEach(item => walk(item, visitor, depth + 1));
    if (typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
        visitor(key, child);
        walk(child, visitor, depth + 1);
    }
}

function parseResponse(httpOk, body) {
    const status = String(body?.EINV_STATUS || '');
    const resultStatus = String(body?.EINV_RESULTS?.status || '');
    const errors = body?.EINV_RESULTS?.ERRORS;
    let qrText = null;
    let governmentUuid = null;
    walk(body, (key, value) => {
        if (!qrText && key === 'EINV_QR' && typeof value === 'string' && value.trim()) qrText = value;
        if (!governmentUuid && ['EINV_UUID', 'UUID'].includes(key) && typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value)) governmentUuid = value;
    });
    const normalizedStatus = status.trim().toUpperCase();
    const normalizedResultStatus = resultStatus.trim().toUpperCase();
    const successTokens = new Set(['SUBMITTED', 'PASS']);
    const rejectionTokens = new Set(['NOT_SUBMITTED', 'ERROR', 'REJECT', 'REJECTED']);
    const explicitSuccess = successTokens.has(normalizedStatus) || successTokens.has(normalizedResultStatus);
    const explicitRejection = rejectionTokens.has(normalizedStatus) || rejectionTokens.has(normalizedResultStatus) || (Array.isArray(errors) && errors.length > 0);
    const hasQr = typeof qrText === 'string' && qrText.trim().length > 0;
    const firstError = Array.isArray(errors) && errors.find(error => error && typeof error === 'object');
    const errorCode = String(firstError?.EINV_CODE || '').trim().slice(0, 120);
    const errorMessage = String(firstError?.EINV_MESSAGE || firstError?.message || '').trim().slice(0, 360);
    const rejectionDetail = [errorCode, errorMessage].filter(Boolean).join(' — ');
    const rejectionError = rejectionDetail ? `JoFotara rejected the document: ${rejectionDetail}` : 'JoFotara rejected the document.';
    if (httpOk && explicitSuccess && hasQr && !explicitRejection) return { outcome: 'accepted', qrText, governmentUuid, error: null };
    if (!httpOk && explicitRejection && !explicitSuccess && !hasQr) return { outcome: 'rejected', qrText, governmentUuid, error: rejectionError };
    if (httpOk && explicitRejection && !explicitSuccess && !hasQr) return { outcome: 'rejected', qrText, governmentUuid, error: rejectionError };
    return { outcome: 'unknown', qrText, governmentUuid, error: 'JoFotara response could not be verified.' };
}

async function submitXml({ clientId, secretKey, xml, fetchImpl = fetch }) {
    let response;
    try {
        response = await fetchImpl(ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Client-Id': clientId, 'Secret-Key': secretKey },
            body: JSON.stringify({ invoice: Buffer.from(xml, 'utf8').toString('base64') }),
            signal: AbortSignal.timeout(30000)
        });
    } catch (error) {
        return { outcome: 'unknown', httpStatus: null, qrText: null, governmentUuid: null, responseBody: null, error: error.name === 'TimeoutError' ? 'Request timed out.' : 'Network request failed.' };
    }
    const raw = await response.text();
    let body;
    try { body = JSON.parse(raw); } catch { body = null; }
    const parsed = parseResponse(response.ok, body);
    return { ...parsed, httpStatus: response.status, responseBody: raw };
}

module.exports = { ENDPOINT, parseResponse, submitXml };
