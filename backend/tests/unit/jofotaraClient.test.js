const { parseResponse, submitXml } = require('../../services/JofotaraClient');

describe('JoFotara client', () => {
    it('requires response acceptance and extracts QR defensively', () => {
        expect(parseResponse(true, { EINV_STATUS: 'SUBMITTED', nested: { EINV_QR: 'qr-value' } })).toMatchObject({ outcome: 'accepted', qrText: 'qr-value' });
        expect(parseResponse(true, { EINV_STATUS: 'NOT_SUBMITTED' }).outcome).toBe('rejected');
        expect(parseResponse(true, { EINV_RESULTS: { status: 'ERROR', ERRORS: ['bad'] } }).outcome).toBe('rejected');
    });

    it('base64 wraps XML and sends credentials only as headers', async () => {
        let request;
        const result = await submitXml({
            clientId: 'client', secretKey: 'secret', xml: '<Invoice/>',
            fetchImpl: async (url, options) => {
                request = { url, options };
                return { ok: true, status: 200, text: async () => JSON.stringify({ EINV_STATUS: 'PASS', EINV_QR: 'qr' }) };
            }
        });
        expect(result.outcome).toBe('accepted');
        expect(request.options.headers['Client-Id']).toBe('client');
        expect(JSON.parse(request.options.body).invoice).toBe(Buffer.from('<Invoice/>').toString('base64'));
        expect(request.options.body).not.toContain('secret');
    });

    it('marks network ambiguity unknown without exposing credentials', async () => {
        const result = await submitXml({ clientId: 'client', secretKey: 'very-secret', xml: '<Invoice/>', fetchImpl: async () => { throw new Error('offline'); } });
        expect(result).toMatchObject({ outcome: 'unknown', error: 'Network request failed.' });
        expect(JSON.stringify(result)).not.toContain('very-secret');
    });

    it('fails closed when a successful transport response is not verifiable', () => {
        expect(parseResponse(true, {}).outcome).toBe('unknown');
        expect(parseResponse(true, null).outcome).toBe('unknown');
        expect(parseResponse(true, { EINV_STATUS: 'PASS' }).outcome).toBe('unknown');
        expect(parseResponse(true, { EINV_QR: 'opaque' }).outcome).toBe('unknown');
    });

    it('preserves the official QR payload byte-for-byte', () => {
        const qr = '  opaque/QR+payload=\u0000\u00e9  ';
        expect(parseResponse(true, { EINV_STATUS: 'SUBMITTED', EINV_QR: qr })).toMatchObject({ outcome: 'accepted', qrText: qr });
    });

    it('does not treat arbitrary nested qr-like fields as the official QR', () => {
        expect(parseResponse(true, { EINV_STATUS: 'SUBMITTED', nested: { qrPayload: 'not-authoritative' } })).toMatchObject({ outcome: 'unknown', qrText: null });
    });

    it('classifies explicit rejection evidence as rejected', () => {
        expect(parseResponse(true, { EINV_STATUS: 'NOT_SUBMITTED' }).outcome).toBe('rejected');
        expect(parseResponse(true, { EINV_STATUS: 'ERROR' }).outcome).toBe('rejected');
        expect(parseResponse(true, { EINV_STATUS: 'REJECT' }).outcome).toBe('rejected');
        expect(parseResponse(true, { EINV_RESULTS: { status: 'ERROR', ERRORS: ['bad'] } }).outcome).toBe('rejected');
    });

    it('keeps the first government rejection code and message for operators', () => {
        const result = parseResponse(false, {
            EINV_STATUS: 'NOT_SUBMITTED',
            EINV_RESULTS: {
                status: 'ERROR',
                ERRORS: [{ EINV_CODE: 'generalInvoiceCalculations', EINV_MESSAGE: 'Error in general tax amount calculation for general invoice' }]
            }
        });

        expect(result).toMatchObject({
            outcome: 'rejected',
            error: 'JoFotara rejected the document: generalInvoiceCalculations — Error in general tax amount calculation for general invoice'
        });
    });

    it('classifies ambiguous non-2xx responses as unknown', () => {
        expect(parseResponse(false, {}).outcome).toBe('unknown');
        expect(parseResponse(false, null).outcome).toBe('unknown');
        expect(parseResponse(false, { EINV_STATUS: 'PASS', EINV_QR: 'opaque' }).outcome).toBe('unknown');
    });
});
