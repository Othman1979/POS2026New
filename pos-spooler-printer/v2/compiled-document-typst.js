const path = require('path');

const WIDTH = 576;
const CONTENT_WIDTH = 556;
const MAX_LAYOUT_BYTES = 256 * 1024;
const MAX_NODES = 1200;
const MAX_IMAGE_BYTES = 160 * 1024;
const SANS_FONT_STACK = '("Noto Sans", "Noto Sans Arabic", "Noto Emoji")';

const FONT_SIZE = Object.freeze({
    xs: 18, sm: 22, note: 24, item: 25, base: 26,
    lg: 30, total: 34, xl: 36, '2xl': 44, display: 48, '3xl': 52
});
const FONT_WEIGHT = Object.freeze({ normal: 400, bold: 600, black: 700 });
const INHERITED_STYLE = new Set([
    'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'align', 'direction',
    'textTransform', 'letterSpacing', 'lineHeight', 'opacity', 'treatment'
]);
const STYLE_KEYS = new Set([
    ...INHERITED_STYLE, 'width', 'marginTop', 'marginBottom', 'marginInlineStart', 'offsetY',
    'padding', 'labelLayout'
]);
const BASE_STYLE = Object.freeze({
    fontFamily: 'sans', fontSize: 'item', fontWeight: 'normal', fontStyle: 'normal',
    align: 'left', direction: 'auto', textTransform: 'none', letterSpacing: 0,
    lineHeight: 1.2, opacity: 1, treatment: 'plain'
});

function unsupported(message) {
    const error = new Error(message);
    error.code = 'TYPST_DOCUMENT_UNSUPPORTED';
    error.failureClass = 'permanent_safe';
    throw error;
}

function plainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function onlyKeys(value, allowed, label) {
    if (!plainObject(value)) unsupported(`Typst ${label} must be an object`);
    for (const key of Object.keys(value)) if (!allowed.has(key)) unsupported(`Typst ${label} does not support ${key}`);
    return value;
}

function boundedString(value, label, { allowEmpty = false, maxBytes = 65536 } = {}) {
    if (typeof value !== 'string' || (!allowEmpty && !value) || Buffer.byteLength(value, 'utf8') > maxBytes || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
        unsupported(`Typst ${label} is invalid`);
    }
    return value;
}

function boundedNumber(value, label, { min = 0, max = 100000, integer = false } = {}) {
    if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isSafeInteger(value))) unsupported(`Typst ${label} is invalid`);
    return value;
}

function validateStyle(value = {}, label = 'style') {
    onlyKeys(value, STYLE_KEYS, label);
    if (value.fontFamily !== undefined && !['sans', 'mono', 'arabic'].includes(value.fontFamily)) unsupported(`Typst ${label}.fontFamily is invalid`);
    if (value.fontSize !== undefined && !Object.hasOwn(FONT_SIZE, value.fontSize)) unsupported(`Typst ${label}.fontSize is invalid`);
    if (value.fontWeight !== undefined && !Object.hasOwn(FONT_WEIGHT, value.fontWeight)) unsupported(`Typst ${label}.fontWeight is invalid`);
    if (value.fontStyle !== undefined && !['normal', 'italic'].includes(value.fontStyle)) unsupported(`Typst ${label}.fontStyle is invalid`);
    if (value.align !== undefined && !['left', 'center', 'right'].includes(value.align)) unsupported(`Typst ${label}.align is invalid`);
    if (value.direction !== undefined && !['auto', 'ltr', 'rtl'].includes(value.direction)) unsupported(`Typst ${label}.direction is invalid`);
    if (value.textTransform !== undefined && !['none', 'uppercase'].includes(value.textTransform)) unsupported(`Typst ${label}.textTransform is invalid`);
    if (value.treatment !== undefined && !['plain', 'outline', 'reverse'].includes(value.treatment)) unsupported(`Typst ${label}.treatment is invalid`);
    if (value.labelLayout !== undefined && !['apart', 'stacked', 'inline'].includes(value.labelLayout)) unsupported(`Typst ${label}.labelLayout is invalid`);
    for (const key of ['width', 'marginTop', 'marginBottom', 'marginInlineStart', 'padding', 'letterSpacing']) {
        if (value[key] !== undefined) boundedNumber(value[key], `${label}.${key}`, { max: key === 'width' ? 100 : 200 });
    }
    if (value.offsetY !== undefined) boundedNumber(value.offsetY, `${label}.offsetY`, { min: -20, max: 20 });
    if (value.width !== undefined && value.width <= 0) unsupported(`Typst ${label}.width is invalid`);
    if (value.lineHeight !== undefined) boundedNumber(value.lineHeight, `${label}.lineHeight`, { min: 1, max: 2 });
    if (value.opacity !== undefined) boundedNumber(value.opacity, `${label}.opacity`, { max: 1 });
    return value;
}

function validateSegments(value, label, { allowEmpty = false } = {}) {
    if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > 32) unsupported(`Typst ${label} is invalid`);
    return value.map((segment, index) => {
        onlyKeys(segment, new Set(['text', 'direction']), `${label}[${index}]`);
        if (!['auto', 'ltr', 'rtl'].includes(segment.direction)) unsupported(`Typst ${label}[${index}].direction is invalid`);
        return {
            text: boundedString(segment.text, `${label}[${index}].text`, { allowEmpty: true }),
            direction: segment.direction
        };
    });
}

function validateBox(value, label) {
    onlyKeys(value, new Set(['x', 'y', 'width', 'height']), label);
    const box = {
        x: boundedNumber(value.x, `${label}.x`, { max: WIDTH }),
        y: boundedNumber(value.y, `${label}.y`, { max: 2400 }),
        width: boundedNumber(value.width, `${label}.width`, { min: 1, max: WIDTH }),
        height: boundedNumber(value.height, `${label}.height`, { min: 1, max: 2400 })
    };
    if (box.x + box.width > WIDTH || box.y + box.height > 2400) unsupported(`Typst ${label} is outside its container`);
    return box;
}

function validateImageData(value, label) {
    const match = boundedString(value, label, { maxBytes: MAX_IMAGE_BYTES * 2 }).match(/^data:image\/(png|jpeg|webp|ico|x-icon|vnd\.microsoft\.icon);base64,([a-z0-9+/]+={0,2})$/i);
    if (!match) unsupported(`Typst ${label} is invalid`);
    const bytes = Buffer.from(match[2], 'base64');
    if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) unsupported(`Typst ${label} exceeds its limit`);
    const extension = match[1].toLowerCase() === 'jpeg' ? 'jpg'
        : ['ico', 'x-icon', 'vnd.microsoft.icon'].includes(match[1].toLowerCase()) ? 'ico'
            : match[1].toLowerCase();
    return { bytes, extension };
}

function inheritedFrom(style) {
    const result = { ...BASE_STYLE };
    for (const [key, value] of Object.entries(style || {})) if (INHERITED_STYLE.has(key)) result[key] = value;
    return result;
}

function computedStyle(explicit, parent = BASE_STYLE, { field = false, inRow = false, divider = false, image = false } = {}) {
    const style = inheritedFrom(parent);
    if (field) style.marginBottom = inRow ? 0 : 6;
    if (divider) Object.assign(style, { width: 100, marginTop: 14, marginBottom: 10 });
    if (image) style.align = 'center';
    Object.assign(style, validateStyle(explicit || {}));
    return style;
}

function typstString(value) {
    return JSON.stringify(String(value));
}

function breakLongAsciiRuns(value) {
    return value.replace(/[\x21-\x7e]{19,}/g, token => [...token].join('\u200b'));
}

function textArguments(style) {
    const family = style.fontFamily === 'mono' ? '("DejaVu Sans Mono",)'
        : SANS_FONT_STACK;
    const opacity = Math.round(style.opacity * 255).toString(16).padStart(2, '0');
    const fill = style.treatment === 'reverse' ? `rgb("#ffffff${opacity}")` : `rgb("#000000${opacity}")`;
    return [
        `font: ${family}`,
        `size: ${FONT_SIZE[style.fontSize]}pt`,
        // Noto Arabic's font-wide ascender/descender metrics reserve space for
        // unusually tall marks. Use stable receipt line boxes instead.
        'top-edge: 1.05em',
        'bottom-edge: 0.4em',
        `weight: ${FONT_WEIGHT[style.fontWeight]}`,
        `style: ${typstString(style.fontStyle)}`,
        `tracking: ${style.letterSpacing}pt`,
        `dir: ${style.direction}`,
        `fill: ${fill}`
    ].join(', ');
}

function renderText(value, style) {
    const transformed = style.textTransform === 'uppercase' ? value.toUpperCase() : value;
    return breakLongAsciiRuns(transformed).split(/\r?\n/).map((line, index) =>
        `${index ? '#linebreak()' : ''}#text(${textArguments(style)})[#(${typstString(line)})]`
    ).join('');
}

function renderSegments(segments, style) {
    return segments.map(segment => renderText(segment.text, { ...style, direction: segment.direction || style.direction })).join('');
}

function blockArguments(style, { width, height, clip = false, ignoreMargins = false, insetRight = 0 } = {}) {
    const args = [];
    if (width !== undefined) args.push(`width: ${width}`);
    else if (style.width) args.push(`width: ${style.width}%`);
    else args.push('width: 100%');
    if (height !== undefined) args.push(`height: ${height}`);
    args.push(`above: ${ignoreMargins ? 0 : (style.marginTop || 0)}pt`);
    args.push(`below: ${ignoreMargins ? 0 : (style.marginBottom || 0)}pt`);
    const insets = [];
    if (style.marginInlineStart) insets.push(`left: ${style.marginInlineStart}pt`);
    if (insetRight) insets.push(`right: ${insetRight}pt`);
    if (style.padding) args.push(`inset: ${style.padding}pt`);
    else if (insets.length) args.push(`inset: (${insets.join(', ')})`);
    if (style.treatment === 'reverse') args.push('fill: black');
    if (style.treatment === 'outline') args.push('stroke: 3pt + black');
    if (clip) args.push('clip: true');
    return args.join(', ');
}

function wrapBlock(body, style, options = {}) {
    // Font bounds alone do not provide space between a descender and the next
    // line's accent. Preserve a minimum thermal gap even for compact templates.
    const leading = Math.max(0.52, style.lineHeight - 1) * FONT_SIZE[style.fontSize];
    const aligned = `#align(${style.align})[${body}]`;
    const content = style.offsetY ? `#move(dy: ${style.offsetY}pt)[${aligned}]` : aligned;
    return `#block(${blockArguments(style, options)})[#set par(leading: ${leading.toFixed(3)}pt); ${content}]`;
}

function validateNode(raw, state, context) {
    if (++state.nodeCount > MAX_NODES) unsupported('Typst native layout has too many nodes');
    onlyKeys(raw, new Set(['id', 'type', 'style', 'box', 'value', 'label', 'labelStyle', 'valueStyle', 'kitchenRole', 'layout', 'height', 'nodes', 'variant', 'size', 'imageType', 'dataUri']), 'node');
    const node = {
        id: boundedString(raw.id, 'node id', { maxBytes: 120 }),
        type: boundedString(raw.type, 'node type', { maxBytes: 32 }),
        style: validateStyle(raw.style || {}, 'node style')
    };
    if (context.positioned) node.box = validateBox(raw.box, 'node box');
    else if (raw.box !== undefined) unsupported('Typst flow nodes cannot contain a box');
    if (node.type === 'text') node.value = validateSegments(raw.value, 'text value');
    else if (node.type === 'field') {
        node.label = validateSegments(raw.label, 'field label', { allowEmpty: true });
        node.value = validateSegments(raw.value, 'field value');
        node.labelStyle = validateStyle(raw.labelStyle || {}, 'field label style');
        node.valueStyle = validateStyle(raw.valueStyle || {}, 'field value style');
        if (raw.kitchenRole !== undefined && !['quantity', 'name'].includes(raw.kitchenRole)) unsupported('Typst kitchen role is invalid');
        if (raw.kitchenRole) node.kitchenRole = raw.kitchenRole;
    } else if (node.type === 'row') {
        if (!['flow', 'absolute'].includes(raw.layout)) unsupported('Typst row layout is invalid');
        node.layout = raw.layout;
        if (raw.layout === 'absolute') node.height = boundedNumber(raw.height, 'row height', { min: 1, max: 2400 });
        if (!Array.isArray(raw.nodes) || raw.nodes.length > MAX_NODES) unsupported('Typst row nodes are invalid');
        node.nodes = raw.nodes.map(child => validateNode(child, state, { positioned: raw.layout === 'absolute' }));
    } else if (node.type === 'divider') {
        if (!['solid', 'dashed'].includes(raw.variant)) unsupported('Typst divider variant is invalid');
        node.variant = raw.variant;
    } else if (node.type === 'spacer') node.size = boundedNumber(raw.size, 'spacer size', { min: 1, max: 1200 });
    else if (node.type === 'image') {
        if (!['qr', 'logo'].includes(raw.imageType)) unsupported('Typst image type is invalid');
        node.imageType = raw.imageType;
        node.size = boundedNumber(raw.size, 'image size', { min: 1, max: CONTENT_WIDTH });
        node.image = validateImageData(raw.dataUri, 'image data');
    } else unsupported(`Typst node type ${node.type} is unsupported`);
    return node;
}

function resolveNativeLayout(data, printType) {
    const artifact = data?.compiled_document_v1;
    if (!['receipt', 'kitchen'].includes(printType) || !plainObject(artifact) || artifact.version !== 1 || artifact.kind !== 'compiled_document_v1' ||
        artifact.docType !== printType || artifact.widthPx !== WIDTH || artifact.compilerVersion !== 1) unsupported('Typst compiled document type or version is invalid');
    boundedString(artifact.templateRevisionId, 'template revision', { maxBytes: 200 });
    if (artifact.templateRevisionId !== `builtin:${printType}-v1` && !/^revision:[1-9]\d*$/.test(artifact.templateRevisionId)) unsupported('Typst template revision is invalid');
    const layout = artifact.nativeLayout;
    if (!plainObject(layout) || layout.version !== 1 || layout.docType !== printType || layout.widthPx !== WIDTH || !Array.isArray(layout.bands) || layout.bands.length > MAX_NODES) {
        unsupported('Typst native layout is invalid');
    }
    if (Buffer.byteLength(JSON.stringify(layout), 'utf8') > MAX_LAYOUT_BYTES) unsupported('Typst native layout exceeds its limit');
    const state = { nodeCount: 0 };
    const bands = layout.bands.map(raw => {
        onlyKeys(raw, new Set(['id', 'layout', 'height', 'nodes']), 'band');
        const band = {
            id: boundedString(raw.id, 'band id', { maxBytes: 120 }),
            layout: ['flow', 'absolute'].includes(raw.layout) ? raw.layout : unsupported('Typst band layout is invalid')
        };
        if (band.layout === 'absolute') band.height = boundedNumber(raw.height, 'band height', { min: 1, max: 2400 });
        if (!Array.isArray(raw.nodes) || raw.nodes.length > MAX_NODES) unsupported('Typst band nodes are invalid');
        band.nodes = raw.nodes.map(node => validateNode(node, state, { positioned: band.layout === 'absolute' }));
        return band;
    });
    return { artifact, layout: { ...layout, bands } };
}

function renderImage(node, style, state, context) {
    // Typst does not decode Windows ICO assets. Older queued native layouts can
    // still contain them, so omit only the optional logo instead of losing the
    // complete receipt in a Typst-only runtime.
    if (node.imageType === 'logo' && node.image.extension === 'ico') return '';
    const name = `image-${state.assets.length + 1}.${node.image.extension}`;
    state.assets.push({ name, bytes: node.image.bytes });
    return wrapBlock(
        `#image(${typstString(path.posix.join(state.assetPrefix, name))}, width: ${node.size}pt, height: ${node.size}pt, fit: "contain")`,
        style,
        context.blockOptions
    );
}

function renderField(node, style, state, context) {
    const labelStyle = computedStyle(node.labelStyle, style);
    const valueStyle = computedStyle(node.valueStyle, style);
    const label = renderSegments(node.label, labelStyle);
    const value = renderSegments(node.value, valueStyle);
    let body = value;
    if (node.label.length) {
        body = style.labelLayout === 'inline'
            ? `${label} ${value}`
            : `#grid(columns: (1fr, auto), gutter: 6pt, [#align(left)[${label}]], [#align(right)[${value}]])`;
    }
    return wrapBlock(body, style, context.blockOptions);
}

function renderPositioned(nodes, height, parentStyle, state, context) {
    const content = nodes.map(node => {
        const rendered = renderNode(node, parentStyle, state, {
            ...context,
            blockOptions: { width: `${node.box.width}pt`, height: `${node.box.height}pt`, clip: true, ignoreMargins: true }
        });
        return `#place(top + left, dx: ${node.box.x}pt, dy: ${node.box.y}pt)[${rendered}]`;
    }).join('');
    return wrapBlock(content, computedStyle({}, parentStyle), { height: `${height}pt`, clip: true });
}

function renderRow(node, style, state, context) {
    if (node.layout === 'absolute') return renderPositioned(node.nodes, node.height, style, state, { ...context, inRow: true });
    if (node.nodes.length === 0) return '';
    if (node.nodes.length === 1) return wrapBlock(renderNode(node.nodes[0], style, state, {
        ...context,
        inRow: true, blockOptions: { width: '100%', ignoreMargins: true }
    }), style, context.blockOptions);
    const edgePair = node.nodes.length === 2 && node.nodes[1].style.align === 'right';
    const columns = edgePair ? '1fr, auto' : node.nodes.map(child => child.kitchenRole === 'quantity' ? 'auto' : child.style.width ? `${child.style.width}fr` : '1fr').join(', ');
    const cells = node.nodes.map((child, index) => {
        const quantity = child.kitchenRole === 'quantity';
        const rendered = renderNode(child, style, state, {
            ...context,
            inRow: true,
            blockOptions: { width: (edgePair && index === 1) || quantity ? 'auto' : '100%', ignoreMargins: true, insetRight: quantity ? 12 : 0 }
        });
        const content = quantity
            ? `#context { let cell = [${rendered}]; box(width: calc.max(75pt, measure(cell).width))[#cell] }`
            : rendered;
        return `[${content}]`;
    }).join(', ');
    const grid = `#grid(columns: (${columns}), column-gutter: ${edgePair ? 8 : 0}pt, align: top, ${cells})`;
    if (edgePair && node.nodes.every(child => child.type === 'field' || child.type === 'text')) {
        // Keep short invoice/date pairs on one line. When both cannot fit,
        // give the identifier the full line instead of splitting it into a
        // narrow column; the date/type stays at the paper's right edge.
        const natural = node.nodes.map(child => renderNode(child, style, state, {
            ...context, inRow: true, blockOptions: { width: 'auto', ignoreMargins: true }
        }));
        const stacked = node.nodes.map(child => renderNode({ ...child, style: { ...child.style, offsetY: 0 } }, style, state, {
            ...context, inRow: true, blockOptions: { width: '100%', ignoreMargins: true }
        })).join('');
        return wrapBlock(`#context { if measure([${natural[0]}]).width + measure([${natural[1]}]).width + 8pt > ${CONTENT_WIDTH}pt { [${stacked}] } else { [${grid}] } }`, style, context.blockOptions);
    }
    return wrapBlock(grid, style, context.blockOptions);
}

function renderNode(node, parentStyle, state, context = {}) {
    const style = computedStyle(node.style, parentStyle, {
        field: node.type === 'field', inRow: context.inRow,
        divider: node.type === 'divider', image: node.type === 'image'
    });
    if (node.type === 'text') return wrapBlock(renderSegments(node.value, style), style, context.blockOptions);
    if (node.type === 'field') return renderField(node, style, state, context);
    if (node.type === 'row') return renderRow(node, style, state, context);
    if (node.type === 'divider') {
        const stroke = node.variant === 'solid' ? '3pt + black' : '(paint: black, thickness: 2pt, dash: "dashed")';
        // A rule is geometry, not a text paragraph: an inline line inherits
        // baseline spacing and can sit against the previous item's descenders.
        // Reserve its actual stroke height so template margins measure from ink.
        const thickness = node.variant === 'solid' ? 3 : 2;
        const above = context.blockOptions?.ignoreMargins ? 0 : (style.marginTop || 0);
        const below = context.blockOptions?.ignoreMargins ? 0 : (style.marginBottom || 0);
        // Keep separator clearance inside its box: Typst's collapsible block
        // spacing can otherwise absorb it at a grid/text boundary.
        return `#block(${blockArguments({ ...style, marginTop: 0, marginBottom: 0 }, { ...context.blockOptions, height: `${above + thickness + below}pt` })})[#place(top, dy: ${above + thickness / 2}pt)[#line(length: 100%, stroke: ${stroke})]]`;
    }
    if (node.type === 'spacer') return wrapBlock('', style, { ...(context.blockOptions || {}), height: `${node.size}pt` });
    if (node.type === 'image') return renderImage(node, style, state, context);
    unsupported(`Typst node type ${node.type} is unsupported`);
}

function renderBand(band, state) {
    if (band.layout === 'absolute') return renderPositioned(band.nodes, band.height, BASE_STYLE, state, { inRow: false });
    return band.nodes.map(node => renderNode(node, BASE_STYLE, state)).join('');
}

function buildTypstDocument(job, { assetPrefix = 'assets' } = {}) {
    if (!/^[a-z0-9][a-z0-9-]{0,80}$/i.test(assetPrefix)) unsupported('Typst asset prefix is invalid');
    const resolved = resolveNativeLayout(job?.data, job?.print_type);
    const state = { assets: [], assetPrefix };
    const body = resolved.layout.bands.map(band => renderBand(band, state)).join('');
    const source = [
        `#set page(width: 576pt, height: auto, margin: (left: 10pt, right: 10pt, top: ${job.print_type === 'kitchen' ? 120 : 5}pt, bottom: ${job.print_type === 'kitchen' ? 200 : 60}pt), fill: white)`,
        `#set text(font: ${SANS_FONT_STACK}, size: 25pt, fill: black)`,
        '#set par(leading: 5pt)',
        body
    ].join('\n');
    return { source, assets: state.assets, artifact: resolved.artifact, width: WIDTH };
}

module.exports = { buildTypstDocument, resolveNativeLayout };
