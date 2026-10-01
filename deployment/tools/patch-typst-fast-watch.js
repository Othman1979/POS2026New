#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ORIGINAL_SHA256 = '081217a463adb006f8894b44227fe4b9c9e91fc85f5463d5948e8370db9bb31e';
const PATCHED_SHA256 = '726d603b83bb39278646e0eb82f8d19f5cfa40c37d2133dcfadef2e1ac5da6b2';
const BEFORE = Buffer.from('c744242000e1f505', 'hex');
const AFTER = Buffer.from('c7442420404b4c00', 'hex');

function sha256(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

function patchBuffer(bytes, {
    originalSha256 = ORIGINAL_SHA256,
    patchedSha256 = PATCHED_SHA256,
    before = BEFORE,
    after = AFTER
} = {}) {
    if (!Buffer.isBuffer(bytes)) throw new TypeError('Typst patch input must be a Buffer.');
    if (!Buffer.isBuffer(before) || !Buffer.isBuffer(after) || before.length === 0 || before.length !== after.length) {
        throw new TypeError('Typst patch signatures must be equal non-empty Buffers.');
    }
    const currentHash = sha256(bytes);
    if (currentHash === patchedSha256) return { bytes, changed: false, sha256: currentHash };
    if (currentHash !== originalSha256) throw new Error(`Typst patch refused unexpected input hash: ${currentHash}`);

    const offset = bytes.indexOf(before);
    if (offset < 0 || bytes.indexOf(before, offset + 1) >= 0) {
        throw new Error('Typst patch requires exactly one verified watcher instruction.');
    }
    const patched = Buffer.from(bytes);
    after.copy(patched, offset);
    const outputHash = sha256(patched);
    if (outputHash !== patchedSha256) throw new Error(`Typst patch output hash mismatch: ${outputHash}`);
    return { bytes: patched, changed: true, offset, sha256: outputHash };
}

function patchFile(file, options = {}) {
    const absolute = path.resolve(file);
    const result = patchBuffer(fs.readFileSync(absolute), options);
    if (!result.changed) return { path: absolute, changed: false, sha256: result.sha256 };

    const temporary = `${absolute}.fast-watch-${process.pid}.tmp`;
    try {
        const descriptor = fs.openSync(temporary, 'wx', 0o755);
        try {
            fs.writeFileSync(descriptor, result.bytes);
            fs.fsyncSync(descriptor);
        } finally {
            fs.closeSync(descriptor);
        }
        if (sha256(fs.readFileSync(temporary)) !== result.sha256) throw new Error('Typst temporary patch verification failed.');
        fs.rmSync(absolute, { force: true });
        fs.renameSync(temporary, absolute);
    } finally {
        fs.rmSync(temporary, { force: true });
    }
    return { path: absolute, changed: true, offset: result.offset, sha256: result.sha256 };
}

module.exports = { AFTER, BEFORE, ORIGINAL_SHA256, PATCHED_SHA256, patchBuffer, patchFile, sha256 };

if (require.main === module) {
    try {
        const [file] = process.argv.slice(2);
        if (!file) throw new Error('Usage: patch-typst-fast-watch.js <typst.exe>');
        process.stdout.write(`${JSON.stringify(patchFile(file))}\n`);
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
