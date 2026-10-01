<template>
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor"
        stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
        <path :d="paths[name]" />
    </svg>
</template>

<script setup>
defineProps({ name: { type: String, required: true } });
// Original 24px outlines with a consistent stroke and optical footprint.
const paths = {
    "dashboard": "M3 3h7v7H3z M14 3h7v4h-7z M14 11h7v10h-7z M3 14h7v7H3z",
    "orders": "M6 3h12v18l-3-2-3 2-3-2-3 2V3Z M9 7h6 M9 11h6 M9 15h3",
    "reports": "M4 3h12l4 4v14H4Z M15 3v5h5 M8 17v-3 M12 17v-6 M16 17v-4",
    "shifts": "M5 5a9 9 0 1 1-2 9 M3 3v5h5 M12 7v5l3 2",
    "customers": "M15 21v-2a5 5 0 0 0-10 0v2 M7 7a3 3 0 1 0 6 0 3 3 0 1 0-6 0 M17 4a3 3 0 0 1 0 6 M19 21v-2a5 5 0 0 0-3-4.6",
    "platform-remittances": "M3 7l9-4 9 4H3Z M6 10v5 M12 10v5 M18 10v3 M3 18h10 M16 17h5l-2-2 M21 17v4 M18 21h-3",
    "jofotara": "M13 21H5V3h10l4 4v5 M14 3v5h5 M8 11h5 M8 15h3 M15 18l2 2 4-5",
    "print-templates": "M7 8V3h10v5 M7 17H3v-7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v7h-4 M7 14h10v7H7Z M17 11h1",
    "inventory": "M3 7l9-4 9 4v10l-9 4-9-4V7Z M3 7l9 4 9-4 M12 11v10 M7.5 5l9 4v4",
    "ingredients": "M3 12h18a9 9 0 0 1-18 0Z M8 21h8 M12 10C10 5 14 2 19 3c0 5-3 7-7 7Z M12 10l4-4 M7 9 5 5",
    "tablemap": "M7 7h10v10H7Z M9 3h6 M9 21h6 M3 9v6 M21 9v6",
    "users": "M12 3l8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z M10 9a2 2 0 1 0 4 0 2 2 0 1 0-4 0 M8 16a4 4 0 0 1 8 0",
    "settings": "M3 6h5 M12 6h9 M3 12h10 M17 12h4 M3 18h3 M10 18h11 M8 3h4v6H8Z M13 9h4v6h-4Z M6 15h4v6H6Z",
    "reports-summary": "M4 4h16v16H4Z M4 9h16 M10 9v11 M13 13h4 M13 16h3",
    "reports-sales": "M4 4v16h17 M8 16v-4 M13 16V9 M18 16V5",
    "reports-refunds": "M8 4 4 8l4 4 M4 8h10a6 6 0 0 1 0 12h-3",
    "reports-product-profit": "M4 20h16 M6 16l4-4 3 3 6-7 M15 8h4v4",
    "reports-expenses": "M20 8H5a2 2 0 0 1 0-4h12v4 M4 6v14h16V8 M20 12h-6v4h6",
    "panel": "M3 4h18v16H3Z M9 4v16 M5 8h1 M5 12h1",
    "close": "M6 6l12 12 M6 18 18 6",
    "chevron": "M6 9l6 6 6-6",
    "reports-ingredients": "M3 12h18a9 9 0 0 1-18 0Z M8 21h8 M12 10C10 5 14 2 19 3c0 5-3 7-7 7Z M12 10l4-4 M7 9 5 5"
};
</script>
