// backend/services/modifierDefs.js
// Canonicalizes an admin-supplied product modifier definition.
// Stable ids: 8-hex, unique within the product, survive renames because the
// admin UI round-trips the parsed JSON (ProductModal keeps unknown fields).
const crypto = require('crypto');

const ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

const toBool = (value) => value === true || value === 1 || value === '1' || value === 'true';

const normalizeModifierDefinition = (raw) => {
    if (raw === undefined || raw === null || raw === '') return null;
    let parsed = raw;
    if (typeof parsed === 'string') {
        try { parsed = JSON.parse(parsed); } catch { throw new Error('Modifiers must be valid JSON.'); }
    }
    if (parsed === null) return null;
    if (!Array.isArray(parsed)) throw new Error('Modifiers must be a list of groups.');
    if (parsed.length === 0) return null;
    if (parsed.length > 50) throw new Error('Too many modifier groups (max 50).');

    const assigned = new Set();
    const claim = (id) => {
        if (typeof id === 'string' && ID_RE.test(id) && !assigned.has(id)) { assigned.add(id); return id; }
        let fresh;
        do { fresh = crypto.randomBytes(4).toString('hex'); } while (assigned.has(fresh));
        assigned.add(fresh);
        return fresh;
    };

    return parsed.map((g) => {
        if (!g || typeof g !== 'object' || Array.isArray(g)) throw new Error('Each modifier group must be an object.');
        const name = typeof g.name === 'string' ? g.name.trim() : '';
        if (!name || name.length > 100) throw new Error('Each modifier group needs a name (max 100 chars).');
        if (!Array.isArray(g.options) || g.options.length === 0) throw new Error(`Modifier group "${name}" needs at least one option.`);
        if (g.options.length > 100) throw new Error(`Modifier group "${name}" has too many options (max 100).`);
        return {
            id: claim(g.id),
            name,
            required: toBool(g.required),
            multi_select: toBool(g.multi_select),
            options: g.options.map((o) => {
                if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error(`Options of "${name}" must be objects.`);
                const optName = typeof o.name === 'string' ? o.name.trim() : '';
                if (!optName || optName.length > 100) throw new Error(`Each option of "${name}" needs a name (max 100 chars).`);
                const price = (o.price === undefined || o.price === null || o.price === '') ? 0 : Number(o.price);
                if (!Number.isFinite(price) || price < 0 || price > 10000) throw new Error(`Option "${optName}" has an invalid price.`);
                return { id: claim(o.id), name: optName, price };
            })
        };
    });
};

module.exports = { normalizeModifierDefinition };
