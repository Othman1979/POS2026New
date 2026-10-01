// The admin Device Access panel refreshes on this event instead of polling.
// It carries no data: the panel re-reads through its own authorised endpoint.
function emitDeviceAccessChanged(req) {
    try { req.io?.to('staff').emit('device_access_changed', {}); } catch { /* a notification failure must never fail a committed action */ }
}

module.exports = { emitDeviceAccessChanged };
