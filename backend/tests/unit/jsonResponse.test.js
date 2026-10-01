const {
    sendPosError,
    sendPosSuccess,
    sendAdminError,
    sendAdminSuccess
} = require('../../http/jsonResponse');

function responseDouble() {
    const res = {
        status: vi.fn(),
        json: vi.fn()
    };
    res.status.mockReturnValue(res);
    res.json.mockReturnValue(res);
    return res;
}

describe('JSON response helpers', () => {
    const databaseMessages = [
        'ER_DUP_ENTRY: duplicate key',
        'SQLSTATE[23000]',
        'mysql connection lost',
        'SQL Error near SELECT',
        "Table 'orders' doesn't exist",
        'table orders does not exist'
    ];

    it.each(databaseMessages)('sanitizes database marker %s for POS', (message) => {
        const res = responseDouble();
        sendPosError(res, 500, message, 'DB_FAILURE');
        expect(res.json).toHaveBeenCalledWith({
            success: false,
            message: 'Operation failed. Please try again.',
            code: 'DB_FAILURE'
        });
    });

    it('keeps non-database client errors and includes codes', () => {
        const res = responseDouble();
        sendPosError(res, 409, 'Conflict', 'CONFLICT');
        expect(res.status).toHaveBeenCalledWith(409);
        expect(res.json).toHaveBeenCalledWith({ success: false, message: 'Conflict', code: 'CONFLICT' });
    });

    it('sanitizes production 500s with the POS fallback', () => {
        const previous = process.env.NODE_ENV;
        process.env.NODE_ENV = 'production';
        const res = responseDouble();
        sendPosError(res, 500, 'secret internals');
        process.env.NODE_ENV = previous;
        expect(res.json).toHaveBeenCalledWith({ success: false, message: 'Operation failed. Please try again.' });
    });

    it('uses the exact admin fallback for production and database errors', () => {
        const previous = process.env.NODE_ENV;
        process.env.NODE_ENV = 'production';
        const prod = responseDouble();
        sendAdminError(prod, 500, 'secret internals');
        const db = responseDouble();
        sendAdminError(db, 400, 'ER_BAD_FIELD_ERROR');
        process.env.NODE_ENV = previous;
        expect(prod.json).toHaveBeenCalledWith({ success: false, message: 'An internal server error occurred.' });
        expect(db.json).toHaveBeenCalledWith({ success: false, message: 'An internal server error occurred.' });
    });

    it('merges success data for POS and admin callers', () => {
        const pos = responseDouble();
        const admin = responseDouble();
        sendPosSuccess(pos, { rows: [1] });
        sendAdminSuccess(admin, { rows: [2] });
        expect(pos.json).toHaveBeenCalledWith({ success: true, rows: [1] });
        expect(admin.json).toHaveBeenCalledWith({ success: true, rows: [2] });
    });
});
