// Rendered check: POS selection highlights switch on the tap's frame, and a tap
// right after a category switch adds exactly the product drawn on the tile.
// Real built UI/API on a generated loopback DB; no checkout, printer or customer data.
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
process.env.POSAPP_REVIEW_DB = `posapp_review_recipe_p1_${randomBytes(6).toString('hex')}`;
require('./recipe-ledger-phase1-preload.cjs');
const mysql = require('mysql2/promise');
const { database, ...options } = require('../../backend/tests/testDatabase.cjs').getTestDatabaseOptions();
const pool = require('../../backend/config/db');
const fixtures = require('../../backend/tests/helpers/fixtures');
const CATEGORIES = [[2, 'Burgers'], [3, 'Drinks'], [4, 'Desserts'], [5, 'Salads']];
let created = false, server, io;

async function seedCatalog() {
    let productId = 100;
    for (const [id, name] of CATEGORIES) {
        await pool.query('INSERT INTO categories (id, name, is_active) VALUES (?, ?, 1)', [id, name]);
        for (let i = 1; i <= 14; i++) {
            await pool.query(
                "INSERT INTO products (id, name, price, tax_rate, jofotara_tax_category, category_id, is_active, is_bundle) VALUES (?, ?, ?, 0, 'O', ?, 1, 0)",
                [productId++, `${name} ${i}`, 1 + i, id]
            );
        }
    }
    const now = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 19).replace('T', ' ');
    await fixtures.insertShift(pool, { user_id: 1, opened_at: now });
}

// Taps `target` in-page (no pointer hover) and samples every element matching
// `selector` on each animation frame. The rendered colours of every element must
// already be their settled values on the first frame and never pass through
// anything else, whatever CSS mechanism would animate them.
function probeSwitch({ selector, target }) {
    const paint = () => [...document.querySelectorAll(selector)].map(el => {
        const style = getComputedStyle(el);
        return `${style.backgroundColor}|${style.color}|${style.borderTopColor}`;
    });
    const before = paint();
    const element = typeof target === 'string'
        ? [...document.querySelectorAll(selector)].find(el => el.textContent.trim() === target)
        : document.querySelectorAll(selector)[target];
    if (!element) return Promise.resolve({ missing: true });
    element.click();
    const frames = [];
    return new Promise(resolve => {
        const started = performance.now();
        const tick = () => {
            frames.push(paint());
            if (performance.now() - started < 450) requestAnimationFrame(tick);
            else {
                const settled = paint();
                const changed = settled.filter((value, i) => value !== before[i]).length;
                const offFrames = frames.filter(frame => frame.some((value, i) => value !== settled[i])).length;
                resolve({ frames: frames.length, changed, firstFrameSettled: frames[0].every((value, i) => value === settled[i]), offFrames });
            }
        };
        requestAnimationFrame(tick);
    });
}

// Taps a category, then the first tile on the next frame; reports what was drawn and added.
function tapRightAfterSwitch(category) {
    const before = document.querySelectorAll('.cart-item-name').length;
    [...document.querySelectorAll('.category-button')].find(el => el.textContent.trim() === category)?.click();
    return new Promise(resolve => requestAnimationFrame(() => {
        const tile = document.querySelector('.product-card');
        const drawn = tile?.querySelector('h3')?.textContent.trim() || null;
        tile?.click();
        setTimeout(() => {
            const names = [...document.querySelectorAll('.cart-item-name')].map(el => el.textContent.trim());
            resolve({ category, drawn, added: names.length > before ? names.at(-1) : null });
        }, 500);
    }));
}

async function acceptance(base, productsByCategory) {
    const { chromium, expect } = require('@playwright/test');
    const browser = await chromium.launch({ headless: true });
    const results = [];
    try {
        for (const [language, width, height] of [['en', 1366, 900], ['ar', 390, 844]]) {
            const context = await browser.newContext({ viewport: { width, height } });
            const errors = [];
            context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
            try {
                expect((await context.request.post(`${base}/api/auth/login`, { data: { user_number: '9001' } })).ok()).toBe(true);
                expect((await context.request.post(`${base}/api/system/settings`, { data: { admin_language: language } })).ok()).toBe(true);
                const page = await context.newPage();
                await page.goto(`${base}/`);
                await page.locator('.product-card').first().waitFor({ timeout: 30000 });
                await page.waitForTimeout(500);
                const result = { language, width, categories: [], taps: [], errors };

                // Visit three categories (first visits), then return to a cached one.
                for (const category of ['Drinks', 'Desserts', 'Burgers', 'Drinks']) {
                    const probe = await page.evaluate(probeSwitch, { selector: '.category-button', target: category });
                    result.categories.push({ category, ...probe });
                    expect(probe.changed, `${language} ${category}: old and new category repaint`).toBe(2);
                    expect(probe.firstFrameSettled, `${language} ${category}: highlight on the tap frame`).toBe(true);
                    expect(probe.offFrames, `${language} ${category}: no in-between highlight frames`).toBe(0);
                    await page.waitForTimeout(300);
                }

                // Cached categories draw at once; the unvisited one is still loading, so nothing is added.
                // A tile drawn right after the tap must belong to the tapped category, never the previous one.
                for (const category of ['Desserts', 'Test Category', 'Salads']) {
                    const tap = await page.evaluate(tapRightAfterSwitch, category);
                    result.taps.push(tap);
                    if (tap.drawn !== null) {
                        expect(productsByCategory[category], `${language} ${category}: drawn tile ${tap.drawn} belongs to the tapped category`).toContain(tap.drawn);
                    }
                    expect(tap.added, `${language} ${category}: tap adds the drawn tile`).toBe(tap.drawn);
                    await page.waitForTimeout(300);
                }
                expect(result.taps.filter(tap => tap.drawn).length).toBeGreaterThanOrEqual(2);

                // Checkout order types in both layouts (a mobile-only or RTL-only rule must not slip through).
                {
                    // The mobile order summary (its label is translated, so match its layout).
                    const openCart = page.locator('[class~="lg:hidden"][class~="bottom-4"] > button');
                    if (await openCart.isVisible()) {
                        await openCart.click();
                        await page.waitForTimeout(300);
                    }
                    await page.locator('.cart-final-action').click();
                    await page.locator('.order-type-option').nth(1).waitFor({ timeout: 10000 });
                    const optionSelector = '.order-type-option, .order-type-mark';
                    if (!(await page.locator('.order-type-option.is-selected').count())) {
                        await page.locator('.order-type-option').first().click();
                        await page.waitForTimeout(300);
                    }
                    const nextIndex = await page.locator('.order-type-option').evaluateAll(els => els.findIndex(el => !el.classList.contains('is-selected')));
                    // Option and mark elements interleave in document order: option i sits at index 2i.
                    const probe = await page.evaluate(probeSwitch, { selector: optionSelector, target: nextIndex * 2 });
                    result.orderType = probe;
                    expect(probe.changed, `${language} order type: old and new option and mark repaint`).toBe(4);
                    expect(probe.firstFrameSettled, `${language} order type: selection on the tap frame`).toBe(true);
                    expect(probe.offFrames, `${language} order type: no in-between frames`).toBe(0);
                }
                expect(errors).toEqual([]);
                results.push(result);
            } finally {
                await context.close();
            }
        }
    } finally {
        await browser.close();
    }
    fs.mkdirSync('scratch/pos-selection-highlight', { recursive: true });
    fs.writeFileSync('scratch/pos-selection-highlight/results.json', JSON.stringify(results, null, 2));
    console.log(JSON.stringify(results.map(r => ({
        language: r.language,
        categories: r.categories.map(c => `${c.category}: first-frame ${c.firstFrameSettled}, off ${c.offFrames}`),
        taps: r.taps.map(t => `${t.category}: drawn ${t.drawn} -> added ${t.added}`),
        orderType: r.orderType && `first-frame ${r.orderType.firstFrameSettled}, off ${r.orderType.offFrames}`,
    })), null, 2));
}

async function run() {
    const admin = await mysql.createConnection(options);
    try { await admin.query(`CREATE DATABASE \`${database}\``); created = true; } finally { await admin.end(); }
    await require('../../backend/tests/fixtures/seed').seedDatabase();
    await seedCatalog();
    ({ server, io } = require('../../server'));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const [rows] = await pool.query('SELECT c.name AS category, p.name FROM products p JOIN categories c ON c.id = p.category_id');
    const productsByCategory = {};
    for (const row of rows) (productsByCategory[row.category] ||= []).push(row.name);
    await acceptance(`http://127.0.0.1:${server.address().port}`, productsByCategory);
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    if (io) await new Promise(resolve => io.close(resolve));
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    await pool.end();
    if (created) {
        const admin = await mysql.createConnection(options);
        try { await admin.query(`DROP DATABASE \`${database}\``); } finally { await admin.end(); }
    }
});
