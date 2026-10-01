const assert = require('node:assert/strict');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createTcpTransport } = require('../v2/printer-transports');

// Real TCP, no printer: the receiver controls when its read side is finished.
(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-tcp-delivery-'));
    const bytes = Buffer.alloc(140000, 0xa5);
    const artifact = { path: path.join(root, 'ticket.bin'), bytes: bytes.length,
        hash: crypto.createHash('sha256').update(bytes).digest('hex') };
    fs.writeFileSync(artifact.path, bytes);
    const sockets = new Set();
    let releasePeer;
    let received;
    const server = net.createServer({ allowHalfOpen: true }, socket => {
        sockets.add(socket);
        const chunks = [];
        socket.on('data', chunk => chunks.push(chunk));
        socket.on('error', () => {});
        socket.on('close', () => sockets.delete(socket));
        socket.on('end', () => {
            received = Buffer.concat(chunks);
            releasePeer = () => socket.end();
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        let completed = false;
        let sentMarked = false;
        const operation = createTcpTransport({ writeIdleMs: 1000, totalMs: 1000 }).send({
            printer: { network_ip: '127.0.0.1', network_port: server.address().port },
            artifact, markTransportStarted() {}, markTransportSent() { sentMarked = true; }
        }).then(result => { completed = true; return result; });
        for (let i = 0; !releasePeer && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 5));
        assert(releasePeer, 'peer received the complete stream');
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.equal(completed, false, 'local write completion must not release the device lane');
        assert.equal(sentMarked, true, 'the durable sent marker precedes the EOF wait');
        assert.deepEqual(received, bytes);
        releasePeer();
        const result = await operation;
        assert.equal(result.success, true);
        assert.equal(result.confidence, 'peer_closed', 'TCP EOF is a stream boundary, not paper confirmation');
        assert.equal(result.warningCode, null);

        // A half-open peer can stop sending status bytes before it finishes
        // receiving the ticket. Do not let Node implicitly cut our write side, and
        // do not hold the printer over it: every write succeeded.
        const earlyChunks = [];
        let peerDone = false;
        const early = net.createServer({ allowHalfOpen: true }, socket => {
            sockets.add(socket);
            socket.on('error', () => {});
            socket.on('close', () => sockets.delete(socket));
            socket.end();
            socket.on('data', chunk => earlyChunks.push(chunk));
            socket.on('end', () => { peerDone = true; socket.destroy(); });
        });
        await new Promise(resolve => early.listen(0, '127.0.0.1', resolve));
        try {
            const big = Buffer.alloc(8 * 1024 * 1024, 0xa5);
            const bigArtifact = { path: path.join(root, 'large.bin'), bytes: big.length,
                hash: crypto.createHash('sha256').update(big).digest('hex') };
            fs.writeFileSync(bigArtifact.path, big);
            const earlyResult = await createTcpTransport().send({
                printer: { network_ip: '127.0.0.1', network_port: early.address().port },
                artifact: bigArtifact, markTransportStarted() {}
            });
            assert.equal(earlyResult.success, true);
            assert.equal(earlyResult.confidence, 'bytes_sent');
            assert.equal(earlyResult.warningCode, 'PRINTER_EOF_EARLY');
            for (let i = 0; !peerDone && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 5));
            assert.deepEqual(Buffer.concat(earlyChunks), big, 'remote early EOF must not truncate our remaining artifact chunks');
        } finally { await new Promise(resolve => early.close(resolve)); }

        // Firmware that never answers our FIN (CUPS needs waiteof=false for it) must
        // not turn every ticket into an uncertain outcome, and must not hold its lane for
        // the stall budget either: an endpoint not yet known waits a bounded time
        // for EOF (15 s by default, shortened here), and is classified as holding only after
        // two consecutive timeouts; from then on tickets get a two-second grace.
        const holding = net.createServer({ allowHalfOpen: true }, socket => {
            sockets.add(socket);
            socket.on('error', () => {});
            socket.on('close', () => sockets.delete(socket));
            socket.on('data', () => {});
            socket.on('end', () => {}); // read everything, never end our side
        });
        await new Promise(resolve => holding.listen(0, '127.0.0.1', resolve));
        try {
            const transport = createTcpTransport({ eofUnknownMs: 400 });
            const printer = { network_ip: '127.0.0.1', network_port: holding.address().port };
            const send = () => transport.send({ printer, artifact, markTransportStarted() {} });
            for (const label of ['first', 'second']) {
                const result = await send();
                assert.equal(result.success, true);
                assert.equal(result.confidence, 'bytes_sent');
                assert.equal(result.warningCode, 'PRINTER_EOF_NOT_OBSERVED');
                assert(result.durationMs >= 350 && result.durationMs < 1500, `the ${label} job on an unknown endpoint waits the full unknown window, took ${result.durationMs} ms`);
            }
            const third = await send();
            assert.equal(third.warningCode, 'PRINTER_EOF_NOT_OBSERVED');
            assert(third.durationMs >= 1900 && third.durationMs < 3500, `after two timeouts the endpoint holds and gets only the short grace, took ${third.durationMs} ms`);
        } finally {
            for (const socket of sockets) socket.destroy(); // half-open peers never close on their own
            await new Promise(resolve => holding.close(resolve));
        }

        // A slow closer (EOF after ~1 s, past the old cut-off) is waited for and learned as
        // 'closes'; a timeout followed by an EOF resets the count, so it never becomes 'holds'.
        let delayMs = 0;
        const slow = net.createServer({ allowHalfOpen: true }, socket => {
            sockets.add(socket);
            socket.on('error', () => {});
            socket.on('close', () => sockets.delete(socket));
            socket.on('data', () => {});
            socket.on('end', () => { if (delayMs !== null) setTimeout(() => socket.end(), delayMs); });
        });
        await new Promise(resolve => slow.listen(0, '127.0.0.1', resolve));
        try {
            const transport = createTcpTransport({ eofUnknownMs: 600, eofHoldsMs: 300 });
            const printer = { network_ip: '127.0.0.1', network_port: slow.address().port };
            const send = () => transport.send({ printer, artifact, markTransportStarted() {} });
            delayMs = null; // never closes: first timeout, count = 1
            assert.equal((await send()).warningCode, 'PRINTER_EOF_NOT_OBSERVED');
            delayMs = 200; // closes in time: reset to 'closes'
            const closed = await send();
            assert.equal(closed.confidence, 'peer_closed');
            delayMs = 1200; // learned closer: waited for beyond the unknown and holds windows
            const late = await send();
            assert.equal(late.confidence, 'peer_closed', 'a learned closer keeps its long wait');
            assert(late.durationMs >= 1100, `took ${late.durationMs} ms`);

            // With production timings a peer that closes after ~5 s is waited for, not cut at 3 s.
            delayMs = 5000;
            const fresh = await createTcpTransport().send({ printer, artifact, markTransportStarted() {} });
            assert.equal(fresh.confidence, 'peer_closed');
            assert(fresh.durationMs >= 4900, `took ${fresh.durationMs} ms`);
        } finally {
            for (const socket of sockets) socket.destroy();
            await new Promise(resolve => slow.close(resolve));
        }
    } finally {
        for (const socket of sockets) socket.destroy();
        await new Promise(resolve => server.close(resolve));
        fs.rmSync(root, { recursive: true, force: true });
    }
    console.log('v2-tcp-delivery tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
