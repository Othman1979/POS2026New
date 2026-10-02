import { ref } from 'vue';
import arDictionaryUrl from './ar.json?url';

const STORAGE_KEY = 'pos_admin_language';
const SUPPORTED_LANGUAGES = new Set(['en', 'ar']);
const RTL_LANGUAGES = new Set(['ar']);
const TRANSLATED_ATTRIBUTES = ['placeholder', 'title', 'aria-label'];
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'CODE', 'PRE', 'CANVAS']);
const MAX_QUEUED_TRANSLATION_TARGETS = 256;
const defaultRuntimeConfig = {
    rootSelector: '#admin-app',
    titleKey: 'POS - Admin',
    rtlBodyClass: 'admin-rtl'
};

let runtimeConfig = { ...defaultRuntimeConfig };

export const currentLanguage = ref(readSavedLanguage());

export const languageChoices = [
    { value: 'en', label: 'English', nativeLabel: 'English', direction: 'ltr' },
    { value: 'ar', label: 'Arabic', nativeLabel: 'العربية', direction: 'rtl' }
];

const dictionaries = Object.create(null);
// Dictionaries are hashed JSON assets fetched with a deadline. Unlike a dynamic import,
// which keeps joining a stalled request, a stalled fetch aborts and fails, so the next
// retry (boot deferral, socket heartbeat) starts a fresh download.
const DICTIONARY_TIMEOUT_MS = 8000;
async function fetchDictionary(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException('Dictionary request timed out.', 'TimeoutError')), DICTIONARY_TIMEOUT_MS);
    try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error(`Dictionary request failed (${response.status}).`);
        return await response.json();
    } finally {
        clearTimeout(timer);
    }
}
const languageLoaders = {
    ar: () => fetchDictionary(arDictionaryUrl)
};
const languageLoads = new Map();
let languageRequestId = 0;

const dynamicTranslations = [
    {
        pattern: /^Enter how many base units the pack (.+) holds\.$/,
        ar: ([, label]) => `اكتب عدد الوحدات الأساسية داخل العبوة ${label}.`
    },
    {
        pattern: /^The pack (.+) must hold more or less than one base unit\.$/,
        ar: ([, label]) => `العبوة ${label} لا يمكن أن تساوي وحدة أساسية واحدة؛ الوحدة الأساسية معرّفة تلقائياً.`
    },
    {
        pattern: /^The sale price of the pack (.+) is invalid\.$/,
        ar: ([, label]) => `سعر بيع العبوة ${label} غير صالح.`
    },
    {
        pattern: /^A product can have at most ([0-9]+) packs\.$/,
        ar: ([, count]) => `الحد الأقصى ${count} عبوات للمادة الواحدة.`
    },
    {
        pattern: /^Each pack needs a name of at most ([0-9]+) characters\.$/,
        ar: ([, count]) => `كل عبوة تحتاج اسماً لا يزيد عن ${count} حرفاً.`
    },
    {
        pattern: /^The pack (.+) is repeated\.$/,
        ar: ([, label]) => `العبوة ${label} مكررة.`
    },
    {
        pattern: /^Barcode (.+) is repeated on this product\.$/,
        ar: ([, barcode]) => `الباركود ${barcode} مكرر في هذه المادة.`
    },
    {
        pattern: /^The pack (.+) has sales; clear its sale price to stop selling it instead of removing it\.$/,
        ar: ([, label]) => `العبوة ${label} لها مبيعات سابقة؛ امسح سعر بيعها لإيقاف بيعها بدلاً من حذفها.`
    },
    {
        pattern: /^([0-9]+) selected$/,
        ar: ([, count]) => `${count} عناصر محددة`
    },
    {
        pattern: /^Only\s+(.+)\s+remaining$/i,
        ar: ([, amount]) => `تبقى ${amount} فقط`
    },
    {
        pattern: /^(.+)\s+-\s+Logout$/i,
        ar: ([, role]) => `${translateRole(role)} - تسجيل الخروج`
    },
    {
        pattern: /^Cashier:\s*(.+)$/i,
        ar: ([, name]) => `الكاشير: ${name}`
    },
    {
        pattern: /^Customer:\s*(.+)$/i,
        ar: ([, name]) => `العميل: ${name}`
    },
    {
        pattern: /^Phone:\s*(.+)$/i,
        ar: ([, phone]) => `الهاتف: ${phone}`
    },
    {
        pattern: /^Address:\s*(.+)$/i,
        ar: ([, address]) => `العنوان: ${translateString(address, 'ar')}`
    },
    {
        pattern: /^INV:\s*(.+)$/i,
        ar: ([, number]) => `فاتورة: ${number}`
    },
    {
        pattern: /^ORDER\s+#(.+)$/i,
        ar: ([, number]) => `طلب #${number}`
    },
    {
        pattern: /^(.+)\s+\(Main\)$/i,
        ar: ([, name]) => `${name} (رئيسي)`
    },
    {
        pattern: /^Welcome,\s*(.+)!$/i,
        ar: ([, name]) => `مرحبا، ${name}!`
    },
    {
        pattern: /^Added:\s*(.+)$/i,
        ar: ([, name]) => `تمت الإضافة: ${name}`
    },
    {
        pattern: /^Unknown Code:\s*(.+)$/i,
        ar: ([, code]) => `رمز غير معروف: ${code}`
    },
    {
        pattern: /^Barcode (.+) is already used by (.+)\.$/,
        ar: ([, code, name]) => `الباركود ${code} مستخدم بالفعل في المنتج ${name}.`
    },
    {
        pattern: /^Barcode (.+) is repeated on this product\.$/,
        ar: ([, code]) => `الباركود ${code} مكرر في هذا المنتج.`
    },
    {
        pattern: /^Order:\s*#(.+)$/i,
        ar: ([, number]) => `الطلب: #${number}`
    },
    {
        pattern: /^Invoice:\s*(.+)$/i,
        ar: ([, number]) => `الفاتورة: ${number}`
    },
    {
        pattern: /^Shift\s+#(.+)$/i,
        ar: ([, number]) => `مناوبة #${number}`
    },
    {
        pattern: /^Table\s+(.+)$/i,
        ar: ([, number]) => `طاولة ${number}`
    },
    {
        pattern: /^Taken At:\s*(.+)$/i,
        ar: ([, value]) => `وقت الطلب: ${value}`
    },
    {
        pattern: /^Course\s+(.+)$/i,
        ar: ([, number]) => `الكورس ${number}`
    },
    {
        pattern: /^Seat\s+(.+)$/i,
        ar: ([, number]) => `مقعد ${number}`
    },
    {
        pattern: /^(.+)\s+suspended tickets$/i,
        ar: ([, count]) => `${count} تذاكر معلقة`
    },
    {
        pattern: /^Requirement Missing: You must select an option for "(.+)"\.$/i,
        ar: ([, name]) => `اختيار مطلوب: يجب اختيار خيار لـ "${name}".`
    },
    {
        pattern: /^Insufficient stock! Only\s+(.+)\s+remaining \(you have\s+(.+)\s+in your cart\)\.$/i,
        ar: ([, available, inCart]) => `المخزون غير كاف. المتبقي ${available} فقط (لديك ${inCart} في السلة).`
    },
    {
        pattern: /^Error loading invoice:\s*(.+)$/i,
        ar: ([, message]) => `خطأ في تحميل الفاتورة: ${message}`
    },
    {
        pattern: /^Failed to save table:\s*(.+)$/i,
        ar: ([, message]) => `فشل حفظ الطاولة: ${message}`
    },
    {
        pattern: /^Ticket:\s*(.+)$/i,
        ar: ([, value]) => `التذكرة: ${value}`
    },
    {
        pattern: /^Table:\s*(.+)$/i,
        ar: ([, value]) => `الطاولة: ${value}`
    },
    {
        pattern: /^Ticket-(.+)$/i,
        ar: ([, value]) => `تذكرة-${value}`
    },
    {
        pattern: /^Order-(.+)$/i,
        ar: ([, value]) => `طلب-${value}`
    },
    {
        pattern: /^Table-(.+)$/i,
        ar: ([, value]) => `طاولة-${value}`
    }
];

let translationObserver = null;
let translateFrame = null;
const queuedTranslationTargets = new Set();
let hasRenderedArabic = currentLanguage.value === 'ar';
let dialogsPatched = false;

export function initI18n(app, options = {}) {
    runtimeConfig = { ...defaultRuntimeConfig, ...runtimeConfig, ...options };

    app.config.globalProperties.$t = t;
    app.config.globalProperties.$language = currentLanguage;
    app.config.globalProperties.$setLanguage = setLanguage;

    app.mixin({
        mounted() {
            queueTranslate(this.$el);
        },
        updated() {
            queueTranslate(this.$el);
        }
    });

    void setLanguage(currentLanguage.value, { persist: false, notify: false });
    patchBrowserDialogs();
    if (hasRenderedArabic) startObserver();
}

export async function prepareLanguage(language = currentLanguage.value) {
    const nextLanguage = normalizeLanguage(language);
    if (nextLanguage === 'en' || dictionaries[nextLanguage]) return true;
    const loader = languageLoaders[nextLanguage];
    if (!loader) return false;

    let pending = languageLoads.get(nextLanguage);
    if (!pending) {
        pending = loader()
            .then(dictionary => {
                dictionaries[nextLanguage] = dictionary || {};
                return true;
            })
            .catch(error => {
                languageLoads.delete(nextLanguage);
                console.error(`Failed to load ${nextLanguage} translations.`, error);
                return false;
            });
        languageLoads.set(nextLanguage, pending);
    }
    return pending;
}

let deferredLanguage = null;
let deferredLanguageLoading = false;

// Boot fell back to English because this dictionary did not load in time:
// apply it when it arrives, or on the next retry after a failure.
export function deferLanguage(language) {
    deferredLanguage = normalizeLanguage(language);
    retryDeferredLanguage();
}

export function retryDeferredLanguage() {
    if (!deferredLanguage || deferredLanguageLoading) return;
    deferredLanguageLoading = true;
    const language = deferredLanguage;
    void setLanguage(language, { persist: false, notify: false })
        .then(applied => { if (applied && deferredLanguage === language) deferredLanguage = null; })
        .finally(() => { deferredLanguageLoading = false; });
}

export async function setLanguage(language, options = {}) {
    const requestId = ++languageRequestId;
    const nextLanguage = normalizeLanguage(language);
    const { persist = true, notify = true } = options;
    if (persist) deferredLanguage = null; // an explicit user choice wins
    if (!await prepareLanguage(nextLanguage) || requestId !== languageRequestId) return false;

    // Unchanged language: the DOM is already translated and the observer covers
    // new nodes, so skip the whole-root walk and the change event.
    if (nextLanguage === currentLanguage.value
        && document.documentElement.lang === nextLanguage
        && document.documentElement.dir === getDirection(nextLanguage)
        && (nextLanguage !== 'ar' || hasRenderedArabic)) {
        if (persist) localStorage.setItem(STORAGE_KEY, nextLanguage);
        return true;
    }

    currentLanguage.value = nextLanguage;
    if (nextLanguage === 'ar' && !hasRenderedArabic) {
        hasRenderedArabic = true;
        startObserver();
    }
    if (persist) localStorage.setItem(STORAGE_KEY, nextLanguage);

    const direction = getDirection(nextLanguage);
    document.documentElement.lang = nextLanguage;
    document.documentElement.dir = direction;
    if (runtimeConfig.rtlBodyClass) {
        document.body?.classList.toggle(runtimeConfig.rtlBodyClass, direction === 'rtl');
    }
    if (runtimeConfig.titleKey) document.title = t(runtimeConfig.titleKey, nextLanguage);

    queueTranslate(resolveRoot());

    if (notify) {
        window.dispatchEvent(new CustomEvent('admin-language-changed', {
            detail: { language: nextLanguage, direction }
        }));
    }
    return true;
}

export function t(value, language = currentLanguage.value) {
    return translateString(value, normalizeLanguage(language));
}

export function getDirection(language = currentLanguage.value) {
    return RTL_LANGUAGES.has(normalizeLanguage(language)) ? 'rtl' : 'ltr';
}

export function onLanguageChange(handler) {
    window.addEventListener('admin-language-changed', handler);
    return () => window.removeEventListener('admin-language-changed', handler);
}

export const POS_I18N_KEY = Symbol('pos-i18n');

export function createPosI18n(options = {}) {
    return {
        install(app) {
            initI18n(app, options);
            app.provide(POS_I18N_KEY, {
                currentLanguage,
                languageChoices,
                setLanguage,
                t,
                getDirection,
                onLanguageChange
            });
        }
    };
}

function readSavedLanguage() {
    if (typeof localStorage === 'undefined') return 'en';
    return normalizeLanguage(localStorage.getItem(STORAGE_KEY) || 'en');
}

function normalizeLanguage(language) {
    return SUPPORTED_LANGUAGES.has(language) ? language : 'en';
}

function normalizeText(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function translateString(value, language = currentLanguage.value) {
    if (value === null || value === undefined) return '';
    const original = String(value);
    const normalized = normalizeText(original);
    if (!normalized || language === 'en') return original;

    const dictionary = dictionaries[language] || {};
    const direct = dictionary[normalized];
    if (direct) return preserveOuterWhitespace(original, direct);

    for (const item of dynamicTranslations) {
        const match = normalized.match(item.pattern);
        if (match && item[language]) {
            return preserveOuterWhitespace(original, item[language](match));
        }
    }

    return original;
}

function preserveOuterWhitespace(source, translated) {
    const leading = source.match(/^\s*/)?.[0] || '';
    const trailing = source.match(/\s*$/)?.[0] || '';
    return `${leading}${translated}${trailing}`;
}

function translateRole(role) {
    const normalized = normalizeText(role).toLowerCase();
    const roles = {
        admin: 'مدير',
        administrator: 'مدير النظام',
        programmer: 'مبرمج',
        cashier: 'كاشير',
        waiter: 'نادل',
        call_center: 'مركز الاتصال'
    };
    return roles[normalized] || role;
}

function startObserver() {
    const root = resolveRoot();
    if (!root || !window.MutationObserver) return;

    if (translationObserver) translationObserver.disconnect();
    translationObserver = new MutationObserver((mutations) => {
        const targets = new Set();
        for (const mutation of mutations) {
            if (mutation.type === 'childList') {
                mutation.addedNodes.forEach((node) => targets.add(node));
            } else {
                targets.add(mutation.target);
            }
        }
        queueTranslate([...targets]);
    });

    translationObserver.observe(root, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: TRANSLATED_ATTRIBUTES
    });
}

function resolveRoot() {
    return document.querySelector(runtimeConfig.rootSelector) || document.body || document.documentElement;
}

function queueTranslate(targets) {
    // An English-only session has no translated DOM to restore. Once Arabic
    // has been shown, keep the observer active so detached nodes reinserted
    // after switching back to English can still recover their original text.
    if (!hasRenderedArabic) return;
    for (const target of Array.isArray(targets) ? targets : [targets]) {
        if (target) queuedTranslationTargets.add(target);
        if (queuedTranslationTargets.size <= MAX_QUEUED_TRANSLATION_TARGETS) continue;
        // Background tabs can pause animation frames while mutations continue.
        // Collapse the queue to connected top-level subtrees instead of retaining
        // every old node. Detached nodes will be queued again if reinserted.
        const owners = new Set();
        for (const target of queuedTranslationTargets) {
            if (!target.isConnected) continue;
            let owner = target;
            while (owner.parentNode && owner.parentNode !== document.body && owner.parentNode !== document.documentElement) {
                owner = owner.parentNode;
            }
            owners.add(owner);
            if (owners.size > MAX_QUEUED_TRANSLATION_TARGETS) {
                owners.clear();
                owners.add(document.body || document.documentElement);
                break;
            }
        }
        queuedTranslationTargets.clear();
        for (const owner of owners) queuedTranslationTargets.add(owner);
    }
    if (translateFrame !== null) return;
    translateFrame = requestAnimationFrame(() => {
        translateFrame = null;
        const targetList = new Set(queuedTranslationTargets);
        queuedTranslationTargets.clear();
        for (const target of targetList) {
            // A language switch may queue the full root while the observer
            // queues descendants. Walk each subtree once without losing either.
            let ancestor = target.parentNode;
            while (ancestor && !targetList.has(ancestor)) ancestor = ancestor.parentNode;
            if (ancestor) continue;
            translateTree(target);
        }
    });
}

function translateTree(root) {
    if (!root) return;

    if (root.nodeType === Node.TEXT_NODE) {
        translateTextNode(root);
        return;
    }

    if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) return;
    if (root.nodeType === Node.ELEMENT_NODE && shouldSkipElement(root)) return;

    translateAttributes(root);

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            if (!normalizeText(node.nodeValue)) return NodeFilter.FILTER_REJECT;
            const parent = node.parentElement;
            if (!parent || shouldSkipElement(parent)) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
        }
    });

    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach(translateTextNode);
}

function translateAttributes(root) {
    const elements = [];
    if (root.nodeType === Node.ELEMENT_NODE) elements.push(root);
    if (root.querySelectorAll) {
        elements.push(...root.querySelectorAll(TRANSLATED_ATTRIBUTES.map((attr) => `[${attr}]`).join(',')));
    }

    for (const element of elements) {
        if (shouldSkipElement(element, { allowFormControl: true })) continue;
        for (const attr of TRANSLATED_ATTRIBUTES) translateAttribute(element, attr);
    }
}

function translateTextNode(node) {
    const original = getOriginalText(node);
    const nextValue = translateString(original);
    if (node.nodeValue !== nextValue) node.nodeValue = nextValue;
}

function translateAttribute(element, attr) {
    if (!element.hasAttribute(attr)) return;
    const original = getOriginalAttribute(element, attr);
    const nextValue = translateString(original);
    if (element.getAttribute(attr) !== nextValue) element.setAttribute(attr, nextValue);
}

function getOriginalText(node) {
    const current = node.nodeValue || '';
    if (node.__i18nOriginalText === undefined) {
        node.__i18nOriginalText = current;
        return current;
    }

    if (!isKnownRenderedValue(current, node.__i18nOriginalText) && normalizeText(current)) {
        node.__i18nOriginalText = current;
    }
    return node.__i18nOriginalText;
}

function getOriginalAttribute(element, attr) {
    if (!element.__i18nOriginalAttrs) element.__i18nOriginalAttrs = {};
    const current = element.getAttribute(attr) || '';
    const previous = element.__i18nOriginalAttrs[attr];

    if (previous === undefined) {
        element.__i18nOriginalAttrs[attr] = current;
        return current;
    }

    if (!isKnownRenderedValue(current, previous) && normalizeText(current)) {
        element.__i18nOriginalAttrs[attr] = current;
    }
    return element.__i18nOriginalAttrs[attr];
}

function isKnownRenderedValue(value, original) {
    return value === original || value === translateString(original, 'en') || value === translateString(original, 'ar');
}

function shouldSkipElement(element, options = {}) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return false;
    if (element.closest?.('[data-no-i18n]')) return true;
    if (options.allowFormControl && ['INPUT', 'TEXTAREA'].includes(element.tagName)) return false;
    return SKIP_TAGS.has(element.tagName) || ['INPUT', 'TEXTAREA'].includes(element.tagName);
}

function patchBrowserDialogs() {
    if (dialogsPatched) return;
    dialogsPatched = true;

    const nativeAlert = window.alert.bind(window);
    const nativeConfirm = window.confirm.bind(window);
    const nativePrompt = window.prompt.bind(window);

    window.alert = (message) => nativeAlert(t(message));
    window.confirm = (message) => nativeConfirm(t(message));
    window.prompt = (message, defaultValue) => nativePrompt(t(message), defaultValue);
}
