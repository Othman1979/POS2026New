'use strict';

const crypto = require('crypto');

const apiKey = crypto.randomBytes(48).toString('base64url');
const apiKeySha256 = crypto.createHash('sha256').update(apiKey, 'utf8').digest('hex');
const quoteSecret = crypto.randomBytes(48).toString('base64url');

console.log('Generated order-intake credentials. The raw Bearer key is shown only here.');
console.log('Store the raw key in the calling gateway or GPT Action secret, never in POSApp files.');
console.log('');
console.log(`Bearer key: ${apiKey}`);
console.log('');
console.log('POSApp environment values:');
console.log(`ORDER_INTAKE_API_KEY_SHA256=${apiKeySha256}`);
console.log(`ORDER_INTAKE_QUOTE_SECRET=${quoteSecret}`);
