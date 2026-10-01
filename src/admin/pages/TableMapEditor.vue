<template>

        <div class="h-full flex flex-col font-sans animate-fade-in text-foreground bg-background space-y-5 pb-6">
            
            <!-- Section selector & actions -->
            <div class="bg-card border border-border rounded-xl shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-4 shrink-0 p-5">
                <!-- Left: Floor Sections Tabs Switcher -->
                <div class="flex items-center gap-2 overflow-x-auto max-w-full hide-scroll">
                    <div class="flex items-center rounded-lg bg-muted p-0.5 border border-border select-none h-9 text-[11px] font-semibold">
                        <button v-for="sec in sections" :key="sec.id" @click="activeSection = sec.id" 
                            :class="[activeSection === sec.id ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground']"
                            class="px-3.5 py-1 rounded-md transition-all focus:outline-none h-full flex items-center whitespace-nowrap">
                            <span data-no-i18n>{{ sec.name }}</span>
                        </button>
                        <div v-if="sections.length === 0" class="text-xs text-muted-foreground px-4 italic">
                            {{ $t('No floor sections exist. Create one to begin.') }}
                        </div>
                    </div>
                </div>

                <!-- Right: Grouped actions -->
                <div class="grid grid-cols-3 sm:flex items-center gap-2 shrink-0 w-full sm:w-auto">
                    <!-- Add Section -->
                    <button @click="addSection" class="h-9 px-2 sm:px-3 bg-background border border-input text-foreground hover:bg-muted font-semibold rounded-lg shadow-sm transition-colors text-xs flex items-center justify-center gap-1.5 focus:outline-none">
                        <i class="fa-solid fa-layer-group text-muted-foreground text-[10px]"></i>
                        <span class="hidden xs:inline sm:inline">{{ $t('Section') }}</span>
                    </button>
                    <!-- Bulk Add -->
                    <button @click="bulkAddTables" :disabled="!activeSection" class="h-9 px-2 sm:px-3 bg-background border border-input text-foreground hover:bg-muted font-semibold rounded-lg shadow-sm transition-colors text-xs flex items-center justify-center gap-1.5 focus:outline-none disabled:opacity-50">
                        <i class="fa-solid fa-bolt text-amber-500 text-[10px]"></i>
                        <span class="hidden xs:inline sm:inline">{{ $t('Bulk') }}</span>
                    </button>
                    <!-- Add Single -->
                    <button @click="addTable" :disabled="!activeSection" class="h-9 px-2 sm:px-3 bg-primary text-primary-foreground hover:bg-primary/90 font-semibold rounded-lg shadow-sm transition-colors text-xs flex items-center justify-center gap-1.5 focus:outline-none disabled:opacity-50">
                        <i class="fa-solid fa-plus text-[10px]"></i>
                        <span class="hidden xs:inline sm:inline">{{ $t('Single') }}</span>
                    </button>
                </div>
            </div>

            <div class="bg-card border border-border rounded-md overflow-hidden flex-1 flex flex-col relative shadow-sm">
                
                <div class="bg-card px-6 py-4 border-b border-border flex justify-between items-center z-10 shrink-0">
                    <h3 class="font-display text-[9px] font-extrabold text-muted-foreground tracking-tight flex items-center">
                        <i class="fa-solid fa-table-cells-large text-muted-foreground mr-3 text-[10px]"></i> {{ $t('Section Grid') }}
                    </h3>
                    <button v-if="activeSection" type="button" @click="deleteSection(activeSection)"
                        :disabled="filteredTables.length > 0"
                        :title="filteredTables.length > 0 ? $t('Delete all tables in this section first.') : ''"
                        class="text-destructive hover:bg-destructive/5 px-2.5 py-1 rounded-md border border-destructive/20 text-[9px] font-extrabold uppercase tracking-widest flex items-center h-7 focus:outline-none disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent">
                        <i class="fa-solid fa-trash mr-2"></i> {{ $t('Delete Section') }}
                    </button>
                </div>

                <div class="flex-1 overflow-y-auto premium-scroll p-6 bg-background relative">
                    
                    <div v-if="isLoading" class="absolute inset-0 bg-background/90 z-40 flex items-center justify-center">
                        <i class="fa-solid fa-circle-notch fa-spin text-4xl text-foreground"></i>
                    </div>

                    <div v-if="filteredTables.length === 0 && !isLoading" class="absolute inset-0 flex flex-col items-center justify-center text-muted-foreground pointer-events-none">
                        <div class="w-16 h-16 bg-muted rounded-full flex items-center justify-center mb-4 border border-border">
                            <i class="fa-solid fa-utensils text-2xl text-muted-foreground"></i>
                        </div>
                        <p class="text-[9px] font-extrabold uppercase tracking-widest text-foreground">{{ $t('Section is Empty') }}</p>
                        <p class="text-xs mt-1.5 font-medium text-muted-foreground">{{ $t("Use 'Bulk Add' to instantly generate your layout.") }}</p>
                    </div>

                    <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8 2xl:grid-cols-10 gap-4">
                        
                        <div v-for="table in filteredTables" :key="table.id" class="aspect-square bg-card border border-border rounded-xl flex flex-col items-center justify-center relative group shadow-sm hover:border-zinc-400 hover:shadow transition-all duration-150">
                            
                            <button type="button" @click="openQrModal(table)" class="absolute -top-2 -left-2 w-6 h-6 bg-primary text-primary-foreground border border-primary/20 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all shadow-md text-xs hover:bg-primary/90 z-20 animate-fade-in" :title="$t('Show QR Code')" :aria-label="$t('Show QR Code')">
                                <i class="fa-solid fa-qrcode"></i>
                            </button>

                            <button type="button" @click="deleteTable(table.id)" class="absolute -top-2 -right-2 w-6 h-6 bg-destructive text-destructive-foreground border border-destructive/20 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all shadow-md text-xs hover:bg-destructive/90 z-20 animate-fade-in" :title="$t('Remove Table')" :aria-label="$t('Remove Table')">
                                <i class="fa-solid fa-trash-can"></i>
                            </button>
                            
                            <span class="font-headline font-bold text-xl text-foreground leading-tight px-2 text-center break-all" data-no-i18n>{{ table.table_number }}</span>
                            <span class="text-[8px] font-extrabold text-muted-foreground uppercase tracking-widest mt-1">{{ $t('Table') }}</span>
                        </div>

                    </div>

                </div>
            </div>
            <!-- QR Code Modal -->
            <ModalShell :show="qrModalOpen" width-class="max-w-md" @close="qrModalOpen = false">
                <template #header>
                    <h3 class="font-display font-bold text-sm tracking-tight text-foreground">
                        <i class="fa-solid fa-qrcode mr-2 text-primary"></i> {{ $t('Table QR Code') }}
                    </h3>
                </template>

                <div class="p-6 flex flex-col items-center text-center overflow-y-auto">
                    <h4 class="font-headline font-bold text-2xl text-foreground mb-1">{{ $t('Table') }} {{ selectedTableForQr?.table_number }}</h4>
                    <p class="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-6">{{ getSectionName(selectedTableForQr?.section_id) }}</p>

                    <div class="p-4 bg-white rounded-lg border border-border shadow-inner mb-6 w-56 h-56 flex items-center justify-center">
                        <img v-if="qrCodeUrl" :src="qrCodeUrl" class="w-48 h-48" alt="QR Code" />
                        <i v-else-if="!qrCodeError" class="fa-solid fa-circle-notch fa-spin text-3xl text-muted-foreground"></i>
                        <div v-else class="text-xs font-semibold text-destructive text-center px-3">{{ qrCodeError }}</div>
                    </div>

                    <div class="w-full text-left space-y-4 mb-6">
                        <div>
                            <label class="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-1 block">{{ $t('Customer Menu URL') }}</label>
                            <div class="flex gap-2">
                                <input type="text" readonly :value="getMenuUrl(selectedTableForQr)" class="flex-1 px-3 py-1.5 bg-muted border border-border rounded text-xs select-all text-muted-foreground font-mono focus:outline-none" />
                                <button type="button" @click="copyMenuUrl(selectedTableForQr)" class="px-3 py-1.5 bg-secondary text-secondary-foreground border border-border hover:bg-secondary/80 rounded text-xs font-bold transition-colors" :title="$t('Copy Link')" :aria-label="$t('Copy Link')">
                                    <i class="fa-solid fa-copy"></i>
                                </button>
                                <button type="button" @click="regenerateTableQrToken(selectedTableForQr)" class="px-3 py-1.5 bg-yellow-600 hover:bg-yellow-700 text-white rounded text-xs font-bold transition-colors" :title="$t('Regenerate Link / Revoke Old')" :aria-label="$t('Regenerate Link / Revoke Old')">
                                    <i class="fa-solid fa-arrows-rotate"></i>
                                </button>
                            </div>
                        </div>
                    </div>
                </div>

                <div class="px-6 py-4 border-t border-border flex justify-end gap-3 bg-muted/30 shrink-0">
                    <button type="button" @click="qrModalOpen = false" class="px-4 py-2 bg-secondary text-secondary-foreground border border-border hover:bg-secondary/80 rounded text-xs font-bold uppercase tracking-widest transition-colors">
                        {{ $t('Close') }}
                    </button>
                    <button type="button" @click="printQrCode(selectedTableForQr)" class="px-4 py-2 bg-primary text-primary-foreground hover:bg-primary/90 rounded text-xs font-bold uppercase tracking-widest transition-colors flex items-center gap-2">
                        <i class="fa-solid fa-print"></i> {{ $t('Print') }}
                    </button>
                </div>
            </ModalShell>
        </div>
</template>

<script>
import { fetchJson } from '@/shared/http.js';
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { t } from '@/shared/i18n.js';
import QRCode from 'qrcode';
import ModalShell from '../components/ModalShell.vue';

export default {
    components: { ModalShell },
    setup() {
        const sections = ref([]);
        const tables = ref([]);
        const activeSection = ref(null);
        const isLoading = ref(false);

        const loadData = async (silent = false) => {
            if (!silent) isLoading.value = true;
            try {
                const data = await fetchJson('api/pos/get_tables?user_id=' + JSON.parse(sessionStorage.getItem('pos_user')).id);
                
                if (data.success) {
                    const prevActiveSection = activeSection.value;
                    const oldSections = [...sections.value];
                    sections.value = data.sections || [];
                    tables.value = data.tables || [];
                    
                    // Match temp section ID to real ID based on name matching
                    if (prevActiveSection && String(prevActiveSection).startsWith('temp-sec-')) {
                        const tempSecName = oldSections.find(s => s.id === prevActiveSection)?.name;
                        const matchedSec = sections.value.find(s => s.name === tempSecName);
                        if (matchedSec) {
                            activeSection.value = matchedSec.id;
                        }
                    }
                    
                    if (!activeSection.value && sections.value.length > 0) {
                        activeSection.value = sections.value[0].id;
                    } else if (sections.value.length === 0) {
                        activeSection.value = null;
                    }
                } else {
                    console.error("API returned error:", data.message);
                }
            } catch (e) {
                console.error("Failed to load map data.", e);
            } finally {
                if (!silent) isLoading.value = false;
            }
        };

        const handleRealtimeEvent = (e) => {
            // The editor shows no status or order data, so a single-table update changes nothing here;
            // only list and structure changes need a reload.
            if (e.detail?.type === 'table_update' && e.detail.payload?.action !== 'update_single_table') {
                loadData(true);
            }
        };

        onMounted(() => {
            loadData();
            window.addEventListener('admin:realtime', handleRealtimeEvent);
        });

        onUnmounted(() => {
            window.removeEventListener('admin:realtime', handleRealtimeEvent);
        });

        const filteredTables = computed(() => {
            return tables.value.filter(t => t.section_id === activeSection.value);
        });

        const addSection = async () => {
            const name = await window.showAdminPrompt(t("Enter new section name (e.g., Main Dining, Patio):"));
            if (name && name.trim()) {
                const trimmed = name.trim();
                const backupSections = [...sections.value];
                const backupActive = activeSection.value;
                const tempId = 'temp-sec-' + Date.now();
                
                sections.value.push({ id: tempId, name: trimmed });
                activeSection.value = tempId;
                
                try {
                    const resData = await fetchJson('api/pos/table_manager', {
                        method: 'POST', 
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ action: 'add_section', name: trimmed }) 
                    });
                    if (resData.success) {
                        window.showAdminToast(t("Floor plan updated."), "success");
                        await loadData(true);
                    } else {
                        sections.value = backupSections;
                        activeSection.value = backupActive;
                        window.showAdminAlert(resData.message || t("Action failed."));
                    }
                } catch (e) {
                    sections.value = backupSections;
                    activeSection.value = backupActive;
                    window.showAdminAlert(t("Action failed due to network error."));
                }
            }
        };

        const deleteSection = async (id) => {
            if (tables.value.some(tbl => tbl.section_id === id)) {
                await window.showAdminAlert(t("Delete all tables in this section first."));
                return;
            }
            if (await window.showAdminConfirm(t("Delete this empty section? This cannot be undone."))) {
                const backupSections = [...sections.value];
                const backupTables = [...tables.value];
                const backupActive = activeSection.value;
                
                sections.value = sections.value.filter(s => s.id !== id);
                tables.value = tables.value.filter(t => t.section_id !== id);
                if (activeSection.value === id) {
                    activeSection.value = sections.value.length > 0 ? sections.value[0].id : null;
                }
                
                try {
                    const resData = await fetchJson('api/pos/table_manager', {
                        method: 'POST', 
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ action: 'delete_section', id }) 
                    });
                    if (resData.success) {
                        window.showAdminToast(t("Floor plan updated."), "success");
                        await loadData(true);
                    } else {
                        sections.value = backupSections;
                        tables.value = backupTables;
                        activeSection.value = backupActive;
                        window.showAdminAlert(resData.message || t("Action failed."));
                    }
                } catch (e) {
                    sections.value = backupSections;
                    tables.value = backupTables;
                    activeSection.value = backupActive;
                    window.showAdminAlert(t("Action failed due to network error."));
                }
            }
        };

        const addTable = async () => {
            if (!activeSection.value) {
                await window.showAdminAlert(t("Please select or create a section first."));
                return;
            }
            const num = await window.showAdminPrompt(t("Enter Table Identifier (e.g., 10, 12B, Bar-1):"));
            if (num && num.trim()) {
                const trimmed = num.trim();
                const backup = [...tables.value];
                const tempId = 'temp-table-' + Date.now();
                
                tables.value.push({
                    id: tempId,
                    section_id: activeSection.value,
                    table_number: trimmed
                });
                
                try {
                    const resData = await fetchJson('api/pos/table_manager', {
                        method: 'POST', 
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ action: 'add_table', section_id: activeSection.value, table_number: trimmed }) 
                    });
                    if (resData.success) {
                        window.showAdminToast(t("Floor plan updated."), "success");
                        await loadData(true);
                    } else {
                        tables.value = backup;
                        window.showAdminAlert(resData.message || t("Action failed."));
                    }
                } catch (e) {
                    tables.value = backup;
                    window.showAdminAlert(t("Action failed due to network error."));
                }
            }
        };

        const bulkAddTables = async () => {
            if (!activeSection.value) {
                await window.showAdminAlert(t("Please select or create a section first."));
                return;
            }
            
            const prefix = await window.showAdminPrompt(t("Enter a prefix (Optional, e.g., 'T-' or 'Bar '). Leave blank for just numbers:"), "");
            if (prefix === null) return;
            
            const countStr = await window.showAdminPrompt(t("How many tables do you want to generate?"), "10");
            if (countStr === null) return;
            
            const count = parseInt(countStr);
            if (isNaN(count) || count <= 0 || count > 100) {
                await window.showAdminAlert(t("Please enter a valid number between 1 and 100."));
                return;
            }

            const existingNums = filteredTables.value.map(t => String(t.table_number).toLowerCase());
            const tablesToAdd = [];
            let added = 0;
            let currentNum = 1;
            
            while(added < count) {
                const candidate = `${prefix}${currentNum}`;
                if (!existingNums.includes(candidate.toLowerCase())) {
                    tablesToAdd.push(candidate);
                    added++;
                }
                currentNum++;
            }

            if (tablesToAdd.length > 0) {
                const backup = [...tables.value];
                const tempTables = tablesToAdd.map((tNum, idx) => ({
                    id: `temp-table-bulk-${Date.now()}-${idx}`,
                    section_id: activeSection.value,
                    table_number: tNum
                }));
                tables.value.push(...tempTables);
                
                try {
                    const resData = await fetchJson('api/pos/table_manager', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ 
                            action: 'bulk_add_tables', 
                            section_id: activeSection.value, 
                            tables: tablesToAdd 
                        })
                    });
                    if (resData.success) {
                        window.showAdminToast(t("Tables generated successfully."), "success");
                        await loadData(true);
                    } else {
                        tables.value = backup;
                        window.showAdminAlert(resData.message || t("Failed to generate tables."));
                    }
                } catch (e) {
                    tables.value = backup;
                    window.showAdminAlert(t("Network error during bulk creation."));
                }
            }
        };

        const deleteTable = async (id) => {
            if (await window.showAdminConfirm(t("Remove this table from the floor plan?"))) {
                const backup = [...tables.value];
                tables.value = tables.value.filter(t => t.id !== id);
                
                try {
                    const resData = await fetchJson('api/pos/table_manager', {
                        method: 'POST', 
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ action: 'delete_table', id }) 
                    });
                    if (resData.success) {
                        window.showAdminToast(t("Floor plan updated."), "success");
                        await loadData(true);
                    } else {
                        tables.value = backup;
                        window.showAdminAlert(resData.message || t("Action failed."));
                    }
                } catch (e) {
                    tables.value = backup;
                    window.showAdminAlert(t("Action failed due to network error."));
                }
            }
        };

        const qrModalOpen = ref(false);
        const selectedTableForQr = ref(null);
        const qrCodeUrl = ref('');
        const qrCodeError = ref('');

        const createQrCodeUrl = async (table, width = 300) => {
            if (!table) return '';
            const url = getMenuUrl(table);
            return QRCode.toDataURL(url, {
                width,
                margin: 2,
                errorCorrectionLevel: 'M',
                color: {
                    dark: '#111827',
                    light: '#ffffff'
                }
            });
        };

        const refreshQrCode = async (table) => {
            qrCodeUrl.value = '';
            qrCodeError.value = '';
            try {
                qrCodeUrl.value = await createQrCodeUrl(table);
            } catch (err) {
                qrCodeError.value = t('Failed to generate QR code.');
            }
        };

        const openQrModal = async (table) => {
            selectedTableForQr.value = table;
            qrModalOpen.value = true;
            await refreshQrCode(table);
        };

        const getSectionName = (sectionId) => {
            const sec = sections.value.find(s => s.id === sectionId);
            return sec ? sec.name : '';
        };

        const getMenuUrl = (table) => {
            if (!table) return '';
            const origin = window.location.origin;
            return `${origin}/menu.html?table=${table.id}&token=${table.qr_code_token || ''}`;
        };

        const copyMenuUrl = async (table) => {
            if (!table) return;
            const url = getMenuUrl(table);
            try {
                await navigator.clipboard.writeText(url);
                window.showAdminToast(t("URL copied to clipboard!"), "success");
            } catch (err) {
                window.showAdminToast(t("Failed to copy URL"), "error");
            }
        };

        const regenerateTableQrToken = async (table) => {
            if (!table) return;
            if (!(await window.showAdminConfirm(t("Are you sure you want to regenerate this QR token? The old QR code and link will stop working immediately.")))) return;
            try {
                const data = await fetchJson('api/pos/table_manager', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'regenerate_qr_token', id: table.id })
                });
                if (data.success && data.data) {
                    table.qr_code_token = data.data.qr_code_token;
                    if (selectedTableForQr.value?.id === table.id) {
                        await refreshQrCode(table);
                    }
                    window.showAdminToast(t("QR code token regenerated successfully!"), "success");
                } else {
                    window.showAdminToast(t("Failed to regenerate QR token"), "error");
                }
            } catch (err) {
                console.error(err);
                window.showAdminToast(t("Error communicating with server"), "error");
            }
        };

        const printQrCode = async (table) => {
            if (!table) return;
            const sectionName = getSectionName(table.section_id);
            const url = getMenuUrl(table);
            let qrUrl = qrCodeUrl.value;
            if (!qrUrl || selectedTableForQr.value?.id !== table.id) {
                try {
                    qrUrl = await createQrCodeUrl(table, 500);
                } catch (err) {
                    window.showAdminToast(t("Failed to generate QR code."), "error");
                    return;
                }
            }
            
            const printWindow = window.open('', '_blank', 'width=600,height=600');
            printWindow.document.write(`
                <html>
                <head>
                    <title>Print QR Code - Table ${table.table_number}</title>
                    <style>
                        body {
                            font-family: 'IBM Plex Sans Arabic', 'Inter', sans-serif;
                            text-align: center;
                            padding: 40px;
                            margin: 0;
                        }
                        .container {
                            border: 2px dashed #ccc;
                            padding: 30px;
                            border-radius: 10px;
                            max-width: 400px;
                            margin: 0 auto;
                        }
                        h1 {
                            font-size: 28px;
                            margin-bottom: 5px;
                            color: #111827;
                        }
                        h2 {
                            font-size: 16px;
                            color: #6b7280;
                            margin-top: 0;
                            margin-bottom: 20px;
                            text-transform: uppercase;
                            letter-spacing: 1px;
                        }
                        .qr-code {
                            width: 250px;
                            height: 250px;
                            margin: 20px auto;
                        }
                        .instructions {
                            font-size: 14px;
                            color: #374151;
                            margin-top: 20px;
                            line-height: 1.5;
                        }
                        .instructions-ar {
                            direction: rtl;
                            font-family: 'IBM Plex Sans Arabic', sans-serif;
                            margin-top: 10px;
                        }
                        @media print {
                            body { padding: 0; }
                            .container { border: none; }
                        }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <h1>Table ${table.table_number}</h1>
                        <h2>${sectionName}</h2>
                        <img class="qr-code" src="${qrUrl}" alt="QR Code" />
                        <div class="instructions">
                            <strong>Scan to View Menu & Order</strong><br>
                            Please scan the QR code to browse our menu and place your order directly.
                        </div>
                        <div class="instructions instructions-ar">
                            <strong>امسح الرمز لعرض القائمة والطلب</strong><br>
                            يرجى مسح رمز QR لتصفح القائمة وطلب وجبتك مباشرة.
                        </div>
                    </div>
                    <script>
                        window.onload = function() {
                            window.print();
                            setTimeout(function() { window.close(); }, 500);
                        };
                    <\/script>
                </body>
                </html>
            `);
            printWindow.document.close();
        };

        return { 
            sections, tables, activeSection, isLoading, filteredTables,
            addSection, deleteSection, addTable, bulkAddTables, deleteTable,
            qrModalOpen, selectedTableForQr, qrCodeUrl, qrCodeError, openQrModal, getSectionName,
            getMenuUrl, copyMenuUrl, printQrCode, regenerateTableQrToken
        };
    }}
</script>
