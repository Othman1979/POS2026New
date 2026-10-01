'use strict';

const crypto = require('crypto');

function readArg(name, fallback = null) {
    const prefix = `--${name}=`;
    const value = process.argv.slice(2).find(arg => arg.startsWith(prefix));
    return value ? value.slice(prefix.length) : fallback;
}

function hasArg(name) {
    return process.argv.slice(2).includes(`--${name}`);
}

function usage() {
    console.log(`Usage:
  $env:ORDER_INTAKE_API_KEY='<raw-bearer-key>'
  npm run order-intake:simulate -- [options]

Options:
  --key=<raw-bearer-key>             Local convenience; environment is safer
  --base-url=http://127.0.0.1:3000   POSApp origin
  --query=burger                       Catalog search text
  --product-id=10                     Select a specific search result
  --order-type-id=1                   Select a specific active order type
  --quantity=1                        Item quantity
  --submit                            Create the confirmed held order
  --verify-replay                     Submit the identical request twice and verify one held order
  --allow-remote-submit               Required with --submit for a non-loopback host
  --help                              Show this help

Environment equivalents:
  ORDER_INTAKE_BASE_URL, ORDER_INTAKE_API_KEY, ORDER_INTAKE_SIM_QUERY,
  ORDER_INTAKE_SIM_PRODUCT_ID, ORDER_INTAKE_SIM_ORDER_TYPE_ID,
  ORDER_INTAKE_ALLOW_REMOTE_SUBMIT=1

The default run stops after receiving a server-authoritative quote.`);
}

async function readJson(response) {
    const text = await response.text();
    try {
        return text ? JSON.parse(text) : null;
    } catch (_) {
        throw new Error(`${response.status} returned non-JSON content: ${text.slice(0, 120)}`);
    }
}

async function call(baseUrl, apiKey, path, options = {}) {
    const response = await fetch(new URL(path, `${baseUrl}/`), {
        ...options,
        headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${apiKey}`,
            ...(options.body ? { 'Content-Type': 'application/json' } : {}),
            ...options.headers,
        },
    });
    const payload = await readJson(response);
    if (!response.ok) {
        const error = new Error(`${response.status} ${payload?.code || 'REQUEST_FAILED'}: ${payload?.message || response.statusText}`);
        error.payload = payload;
        throw error;
    }
    return payload;
}

function isLoopback(hostname) {
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]';
}

async function main() {
    if (hasArg('help')) {
        usage();
        return;
    }
    const baseUrl = String(readArg('base-url', process.env.ORDER_INTAKE_BASE_URL || 'http://127.0.0.1:3000')).replace(/\/$/, '');
    const apiKey = readArg('key', process.env.ORDER_INTAKE_API_KEY || '');
    if (!apiKey) throw new Error('Provide the raw Bearer key with ORDER_INTAKE_API_KEY (recommended) or --key.');
    const target = new URL(baseUrl);
    const submit = hasArg('submit');
    const verifyReplay = hasArg('verify-replay');
    if (verifyReplay && !submit) throw new Error('--verify-replay requires --submit.');
    const allowRemote = hasArg('allow-remote-submit') || process.env.ORDER_INTAKE_ALLOW_REMOTE_SUBMIT === '1';
    if (submit && !isLoopback(target.hostname) && !allowRemote) {
        throw new Error('Remote submission is disabled. Add --allow-remote-submit only after verifying the target database.');
    }

    const query = readArg('query', process.env.ORDER_INTAKE_SIM_QUERY || 'a');
    const requestedProductId = Number(readArg('product-id', process.env.ORDER_INTAKE_SIM_PRODUCT_ID || 0));
    const requestedOrderTypeId = Number(readArg('order-type-id', process.env.ORDER_INTAKE_SIM_ORDER_TYPE_ID || 0));
    const quantity = Number(readArg('quantity', '1'));
    if (!Number.isFinite(quantity) || quantity <= 0) throw new Error('--quantity must be greater than zero.');

    const status = await call(baseUrl, apiKey, '/api/order-intake/v1/status');
    const types = await call(baseUrl, apiKey, '/api/order-intake/v1/order-types');
    const catalog = await call(baseUrl, apiKey, `/api/order-intake/v1/catalog/search?q=${encodeURIComponent(query)}&limit=20`);
    const orderType = requestedOrderTypeId
        ? types.order_types.find(entry => Number(entry.id) === requestedOrderTypeId)
        : types.order_types[0];
    const product = requestedProductId
        ? catalog.products.find(entry => Number(entry.id) === requestedProductId)
        : catalog.products[0];
    if (!orderType) throw new Error('No matching active order type was returned.');
    if (!product) throw new Error('No matching sellable product was returned. Change --query or --product-id.');
    if (product.modifiers?.some(group => group.required)) {
        throw new Error('The selected product has required modifiers. Choose a simpler --product-id for the smoke simulation.');
    }

    const draft = {
        external_request_id: `sim-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
        order_type_id: Number(orderType.id),
        customer: {
            name: 'Order Intake Simulator',
            phone: '0799999999',
            address: 'Local simulation - do not deliver',
        },
        items: [{ product_id: Number(product.id), quantity }],
        order_note: 'Automated order-intake simulation',
    };
    const quoted = await call(baseUrl, apiKey, '/api/order-intake/v1/quotes', {
        method: 'POST',
        body: JSON.stringify(draft),
    });
    const output = {
        target: target.origin,
        client_id: status.client_id,
        dispatch_policy: status.dispatch_policy,
        selected_order_type: orderType,
        selected_product: { id: product.id, name: product.name, quantity },
        quote: {
            expires_at: quoted.expires_at,
            currency: quoted.currency,
            subtotal: quoted.subtotal,
            tax: quoted.tax,
            total: quoted.total,
        },
        submitted: false,
    };

    if (submit) {
        const created = await call(baseUrl, apiKey, '/api/order-intake/v1/held-orders', {
            method: 'POST',
            body: JSON.stringify({ draft, quote_token: quoted.quote_token, confirmed: true }),
        });
        output.submitted = true;
        output.held_order = created.held_order;
        if (verifyReplay) {
            const replayed = await call(baseUrl, apiKey, '/api/order-intake/v1/held-orders', {
                method: 'POST',
                body: JSON.stringify({ draft, quote_token: quoted.quote_token, confirmed: true }),
            });
            if (Number(replayed.held_order?.id) !== Number(created.held_order?.id)
                || replayed.held_order?.replay !== true) {
                throw new Error('Idempotency verification failed: the repeated submission did not replay the first hold.');
            }
            output.replay_verified = true;
            output.replay = replayed.held_order;
            const reconciled = await call(
                baseUrl,
                apiKey,
                `/api/order-intake/v1/requests/${encodeURIComponent(draft.external_request_id)}`,
            );
            if (Number(reconciled.request?.id) !== Number(created.held_order?.id)) {
                throw new Error('Reconciliation verification failed: request lookup did not return the created hold.');
            }
            output.reconciliation_verified = true;
        }
    }
    console.log(JSON.stringify(output, null, 2));
}

main().catch(error => {
    console.error(error.message);
    if (error.payload?.quote) console.error(JSON.stringify({ replacement_quote: error.payload.quote }, null, 2));
    process.exitCode = 1;
});
