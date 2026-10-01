const net = require('node:net');

// One station may have several roles/records for the same physical endpoint.
// A Windows queue name is local to its station; it is not a global device ID.
function printerEndpoint(printer = {}) {
    const type = printer.printer_type || printer.type;
    const name = String(printer.printer_name || printer.windows_name || '').trim().toLowerCase();
    if (type === 'windows' && name) return `windows:${name}`;
    let host = String(printer.network_ip || '').trim().toLowerCase();
    if (net.isIP(host) === 6) host = new URL(`http://[${host}]/`).hostname.slice(1, -1);
    if (net.isIP(host)) return `tcp:[${host}]:${Number(printer.network_port) || 9100}`;
    return `printer:${Number(printer.printer_id ?? printer.id)}`;
}

module.exports = { printerEndpoint };
