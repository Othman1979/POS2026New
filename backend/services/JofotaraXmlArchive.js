const fs = require('fs/promises');
const path = require('path');

function archivePath(document) {
    const root = process.env.DATA_DIR || path.join(__dirname, '../../data');
    const kind = document.document_kind === 'credit_note' ? 'credit-note' : 'invoice';
    const number = String(document.document_number || document.id).replace(/[^\p{L}\p{N}._-]+/gu, '_');
    return path.join(root, 'jofotara', 'xml', `${kind}-${number}-${document.id}.xml`);
}

async function archiveSubmissionXml(document) {
    if (!document?.request_xml) return null;
    const target = archivePath(document);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, document.request_xml, 'utf8');
    return target;
}

module.exports = { archiveSubmissionXml, archivePath };
