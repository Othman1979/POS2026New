const path = require('node:path');

// Vite changes this suffix whenever the file contents change. Only those
// immutable names may outlive a deployment; HTML and the public menu must
// always be revalidated so clients can discover the next build.
const fingerprintedAsset = /-[A-Za-z0-9_-]{8}\.[^./\\]+$/;

function setFrontendStaticHeaders(res, filePath) {
    if (fingerprintedAsset.test(path.basename(filePath))) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
}

module.exports = { setFrontendStaticHeaders };
