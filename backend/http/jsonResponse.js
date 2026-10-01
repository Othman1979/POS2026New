function isDatabaseMessage(message) {
    return typeof message === 'string' && (
        message.includes('ER_') ||
        message.includes('SQLSTATE') ||
        message.includes('mysql') ||
        message.includes('SQL Error') ||
        (message.includes('Table') && message.includes('exist')) ||
        (message.includes('table') && message.includes('exist'))
    );
}

function sendError(res, status, message, code, fallback) {
    let responseMessage = message;
    if ((status === 500 && process.env.NODE_ENV === 'production') || isDatabaseMessage(message)) {
        responseMessage = fallback;
    }
    const payload = { success: false, message: responseMessage };
    if (code) payload.code = code;
    return res.status(status).json(payload);
}

function sendSuccess(res, data) {
    return res.status(200).json({ success: true, ...data });
}

const sendPosError = (res, status, message, code = null) =>
    sendError(res, status, message, code, 'Operation failed. Please try again.');
const sendAdminError = (res, status, message, code = null) =>
    sendError(res, status, message, code, 'An internal server error occurred.');
const sendPosSuccess = sendSuccess;
const sendAdminSuccess = sendSuccess;

module.exports = {
    sendPosError,
    sendPosSuccess,
    sendAdminError,
    sendAdminSuccess
};
