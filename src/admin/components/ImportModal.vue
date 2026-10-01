<template>
    <ModalShell :show="true" width-class="max-w-xl" @close="cancelAndClose">
            <template #header>
                <div class="flex items-center gap-2">
                    <i class="fa-solid fa-file-excel text-emerald-600 text-base"></i>
                    <h3 class="font-bold text-sm select-none">{{ $t('Import Catalog') }}</h3>
                </div>
            </template>

            <!-- Modal Content -->
            <div class="flex-1 overflow-y-auto p-6 premium-scroll">
                <!-- State 1: Uploading/Selecting File -->
                <div v-if="!result" class="space-y-6">
                    <!-- Instruction Card -->
                    <div class="bg-secondary/40 border border-border/80 rounded-md p-4 space-y-3">
                        <h4 class="font-bold text-xs select-none">{{ $t('Instructions') }}</h4>
                        <ul class="text-[11px] text-muted-foreground space-y-1.5 list-disc pl-4 select-none">
                            <li>{{ $t('Use the template below, or upload an old workbook and map its columns.') }}</li>
                            <li>{{ $t('For template imports, keep the tab names "Categories" and "Products" exactly as they are.') }}</li>
                            <li>{{ $t('Duplicate categories (by name) and products (by name or barcode) will be skipped.') }}</li>
                            <li>{{ $t('The import runs as a single database transaction. If any data validation fails, the entire import is rolled back to protect your catalog.') }}</li>
                        </ul>
                        <div class="pt-2">
                            <button @click="downloadTemplate" :disabled="templatePending" class="inline-flex items-center gap-1.5 h-8 px-3 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold rounded text-xs transition-colors shadow-sm focus:outline-none disabled:opacity-50">
                                <i :class="['fa-solid text-[10px]', templatePending ? 'fa-circle-notch fa-spin' : 'fa-download']"></i>
                                <span>{{ templatePending ? $t('Preparing template...') : $t('Download Template') }}</span>
                            </button>
                        </div>
                    </div>

                    <fieldset class="space-y-2">
                        <legend class="text-xs font-bold">{{ $t('Import mode') }}</legend>
                        <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
                            <label
                                class="flex gap-3 rounded-lg border p-3 cursor-pointer transition-colors"
                                :class="importMode === 'append' ? 'border-primary bg-primary/5' : 'border-border hover:bg-secondary/30'"
                            >
                                <input v-model="importMode" value="append" type="radio" class="mt-0.5 accent-primary">
                                <span>
                                    <span class="block text-xs font-bold">{{ $t('Add to current catalog') }}</span>
                                    <span class="block mt-1 text-[10px] leading-4 text-muted-foreground">{{ $t('Keep current products and add new names from the workbook.') }}</span>
                                </span>
                            </label>
                            <label
                                class="flex gap-3 rounded-lg border p-3 cursor-pointer transition-colors"
                                :class="importMode === 'replace' ? 'border-destructive/60 bg-destructive/5' : 'border-border hover:bg-secondary/30'"
                            >
                                <input v-model="importMode" value="replace" type="radio" class="mt-0.5 accent-destructive">
                                <span>
                                    <span class="block text-xs font-bold">{{ $t('Replace current catalog') }}</span>
                                    <span class="block mt-1 text-[10px] leading-4 text-muted-foreground">{{ $t('Remove current products and categories, then import this workbook.') }}</span>
                                </span>
                            </label>
                        </div>
                        <label v-if="importMode === 'replace'" class="flex gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-[10px] leading-4">
                            <input v-model="replacementConfirmed" type="checkbox" class="mt-0.5 accent-destructive shrink-0">
                            <span>{{ $t('I understand that current products, categories, held orders, and saved table drafts will be removed. Completed order history is preserved.') }}</span>
                        </label>
                    </fieldset>

                    <!-- File Drop Zone -->
                    <div 
                        @dragover.prevent="dragOver = true"
                        @dragleave.prevent="dragOver = false"
                        @drop.prevent="handleFileDrop"
                        :aria-busy="inspectionPending"
                        :class="[
                            'border-2 border-dashed rounded-lg p-8 flex flex-col items-center justify-center transition-all cursor-pointer relative',
                            dragOver ? 'border-primary bg-primary/5' : 'border-border hover:border-muted-foreground/40'
                        ]"
                        @click="triggerFileInput"
                    >
                        <input 
                            ref="fileInput"
                            type="file"
                            accept=".xlsx"
                            class="hidden"
                            @change="handleFileSelected"
                        />
                        
                        <div v-if="!selectedFile" class="text-center space-y-2">
                            <i class="fa-solid fa-cloud-arrow-up text-3xl text-muted-foreground opacity-55"></i>
                            <p class="font-bold text-xs">{{ $t('Drag and drop your spreadsheet here') }}</p>
                            <p class="text-[10px] text-muted-foreground">{{ $t('Only .xlsx spreadsheet files are accepted') }}</p>
                        </div>
                        
                        <div v-else class="text-center space-y-2 animate-fade-in w-full px-4">
                            <i :class="['fa-solid text-4xl', inspectionPending ? 'fa-circle-notch fa-spin text-primary' : 'fa-file-excel text-emerald-600']"></i>
                            <p class="font-bold text-xs truncate max-w-full" data-no-i18n>{{ selectedFile.name }}</p>
                            <p class="text-[10px] text-muted-foreground tabular-nums" data-no-i18n>{{ formatBytes(selectedFile.size) }}</p>
                            <p v-if="inspectionPending" class="text-[10px] text-muted-foreground">{{ $t('Reading spreadsheet...') }}</p>
                            <button @click.stop="clearFile" class="text-[10px] font-bold text-destructive hover:underline focus:outline-none">
                                {{ $t('Remove File') }}
                            </button>
                        </div>
                    </div>

                    <div v-if="legacyMapping" class="border border-border rounded-lg bg-secondary/20 p-4 space-y-3">
                        <div>
                            <h4 class="font-bold text-xs">{{ $t('Legacy workbook columns') }}</h4>
                            <p class="text-[10px] text-muted-foreground mt-1">
                                {{ $t('Confirm which columns contain each value. Samples are shown beside each column.') }}
                            </p>
                        </div>
                        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            <label v-for="field in mappingFields" :key="field.key" class="space-y-1">
                                <span class="block text-[10px] font-bold text-foreground">{{ $t(field.label) }}</span>
                                <select
                                    v-model.number="legacyMapping[field.key]"
                                    class="w-full h-9 rounded-md border border-border bg-background px-2 text-xs focus:outline-none focus:border-primary"
                                >
                                    <option :value="null">{{ $t('Select column') }}</option>
                                    <option v-for="option in columnOptions" :key="option.index" :value="option.index">
                                        {{ option.label }}
                                    </option>
                                </select>
                            </label>
                        </div>
                    </div>
                </div>

                <!-- State 2: Results Display -->
                <div v-else class="space-y-6 animate-fade-in">
                    <!-- Success Header -->
                    <div class="flex items-center gap-3 p-4 rounded-md border" :class="result.success ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-700' : 'bg-destructive/10 border-destructive/20 text-destructive'">
                        <i :class="['fa-solid text-xl shrink-0', result.success ? 'fa-circle-check' : 'fa-circle-exclamation']"></i>
                        <div>
                            <h4 class="font-bold text-xs select-none">
                                {{ result.success ? $t('Import Completed Successfully') : $t('Import Failed') }}
                            </h4>
                            <p class="text-[10px] opacity-90 select-none">
                                {{ result.success ? $t('Your catalog data has been updated.') : $t('Errors found in spreadsheet. No changes were committed.') }}
                            </p>
                        </div>
                    </div>

                    <!-- Summary Cards -->
                    <div class="grid grid-cols-2 gap-3 select-none">
                        <div class="border border-border bg-secondary/20 p-3 rounded-md">
                            <p class="text-muted-foreground text-[10px] font-bold uppercase tracking-wider">{{ $t('Categories') }}</p>
                            <div class="mt-1.5 flex items-baseline gap-2">
                                <span class="text-base font-black text-foreground tabular-nums" data-no-i18n>{{ result.summary.categories_imported }}</span>
                                <span class="text-[10px] text-muted-foreground">{{ $t('Added') }}</span>
                            </div>
                            <p class="text-[9px] text-muted-foreground mt-1 tabular-nums" data-no-i18n>
                                {{ result.summary.categories_skipped }} {{ $t('Skipped') }}
                            </p>
                            <p v-if="result.summary.categories_removed" class="text-[9px] text-destructive mt-1 tabular-nums">
                                {{ result.summary.categories_removed }} {{ $t('Removed') }}
                            </p>
                        </div>

                        <div class="border border-border bg-secondary/20 p-3 rounded-md">
                            <p class="text-muted-foreground text-[10px] font-bold uppercase tracking-wider">{{ $t('Products') }}</p>
                            <div class="mt-1.5 flex items-baseline gap-2">
                                <span class="text-base font-black text-foreground tabular-nums" data-no-i18n>{{ result.summary.products_imported }}</span>
                                <span class="text-[10px] text-muted-foreground">{{ $t('Added') }}</span>
                            </div>
                            <p class="text-[9px] text-muted-foreground mt-1 tabular-nums" data-no-i18n>
                                {{ result.summary.products_skipped }} {{ $t('Skipped') }}
                            </p>
                            <p v-if="result.summary.products_removed" class="text-[9px] text-destructive mt-1 tabular-nums">
                                {{ result.summary.products_removed }} {{ $t('Removed') }}
                            </p>
                        </div>
                    </div>

                    <!-- Error Log Block -->
                    <div v-if="result.errors && result.errors.length > 0" class="space-y-2">
                        <div class="flex items-center justify-between border-b border-border pb-1">
                            <p class="font-bold text-xs select-none text-destructive">
                                <i class="fa-solid fa-bug mr-1"></i>
                                <span>{{ $t('Validation Errors') }}</span>
                                <span class="ml-1 px-1.5 py-0.2 rounded bg-destructive/10 text-[10px] font-mono" data-no-i18n>({{ result.errors.length }})</span>
                            </p>
                        </div>
                        <div class="border border-border rounded-md bg-destructive/5 divide-y divide-border max-h-56 overflow-y-auto premium-scroll font-mono text-[10px] text-destructive-foreground">
                            <div v-for="(err, idx) in result.errors" :key="idx" class="p-2.5 leading-relaxed select-all" data-no-i18n>
                                {{ err }}
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Modal Footer -->
            <div class="px-5 py-4 border-t border-border bg-secondary/20 flex items-center justify-end gap-2 shrink-0">
                <template v-if="!result">
                    <button 
                        @click="cancelAndClose"
                        class="h-9 px-4 border border-border hover:bg-muted text-foreground font-semibold rounded-md text-xs transition-colors focus:outline-none"
                        :disabled="loading"
                    >
                        {{ $t('Cancel') }}
                    </button>
                    <button 
                        @click="startImport" 
                        class="h-9 px-4 bg-primary hover:bg-primary/95 text-primary-foreground font-bold rounded-md text-xs flex items-center gap-1.5 transition-all focus:outline-none disabled:opacity-50"
                        :disabled="!selectedFile || loading || inspectionPending || !mappingReady() || (importMode === 'replace' && !replacementConfirmed)"
                    >
                        <i v-if="loading" class="fa-solid fa-circle-notch fa-spin text-[10px]"></i>
                        <span>{{ loading ? $t('Importing...') : $t('Start Import') }}</span>
                    </button>
                </template>
                <template v-else>
                    <button 
                        @click="closeAndReload" 
                        class="h-9 px-5 bg-primary hover:bg-primary/95 text-primary-foreground font-bold rounded-md text-xs transition-all focus:outline-none"
                    >
                        {{ $t('OK') }}
                    </button>
                </template>
            </div>
    </ModalShell>
</template>

<script>
import { fetchJsonResponse } from '@/shared/http.js';
import { onUnmounted, ref } from 'vue';
import { t } from '@/shared/i18n.js';
import ModalShell from './ModalShell.vue';
import { startCatalogWorkbookTask } from './catalogWorkbookWorkerClient.js';

export function createImportModalState(emit, registerCleanup = onUnmounted) {
        const selectedFile = ref(null);
        const fileInput = ref(null);
        const dragOver = ref(false);
        const loading = ref(false);
        const inspectionPending = ref(false);
        const templatePending = ref(false);
        const result = ref(null);
        const importMode = ref('append');
        const replacementConfirmed = ref(false);
        const legacyMapping = ref(null);
        const columnOptions = ref([]);
        const mappingFields = [
            { key: 'name', label: 'Product Name' },
            { key: 'price', label: 'Product Price' },
            { key: 'category', label: 'Product Category' },
            { key: 'tax', label: 'Tax Rate' }
        ];
        let inspectionSequence = 0;
        let inspectionTask = null;
        let templateTask = null;

        const triggerFileInput = () => {
            if (fileInput.value) {
                fileInput.value.click();
            }
        };

        const showFileError = (message) => {
            if (window.showAdminAlert) {
                window.showAdminAlert(t(message), 'error');
            } else {
                alert(t(message));
            }
        };

        const excelColumnName = (index) => {
            let label = '';
            for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) {
                label = String.fromCharCode(65 + ((value - 1) % 26)) + label;
            }
            return label;
        };

        const cancelInspection = () => {
            inspectionSequence += 1;
            inspectionTask?.cancel();
            inspectionTask = null;
            inspectionPending.value = false;
        };

        const cancelTemplate = () => {
            templateTask?.cancel();
            templateTask = null;
            templatePending.value = false;
        };

        const resetFileState = () => {
            selectedFile.value = null;
            legacyMapping.value = null;
            columnOptions.value = [];
        };

        const applyInspection = (inspection) => {
            if (inspection.kind === 'template') {
                legacyMapping.value = null;
                columnOptions.value = [];
                return;
            }

            legacyMapping.value = inspection.mapping;
            columnOptions.value = inspection.columns.map(({ index, samples }) => ({
                index,
                label: `${excelColumnName(index)}${samples.length ? ` — ${samples.join(' · ')}` : ''}`
            }));
        };

        const inspectFile = async (file) => {
            cancelInspection();
            cancelTemplate();
            resetFileState();
            if (!file.name.toLowerCase().endsWith('.xlsx')) {
                if (fileInput.value) fileInput.value.value = '';
                showFileError('Only .xlsx spreadsheet files are allowed.');
                return;
            }

            const sequence = inspectionSequence;
            selectedFile.value = file;
            inspectionPending.value = true;

            try {
                const buffer = await file.arrayBuffer();
                if (sequence !== inspectionSequence) return;
                inspectionTask = startCatalogWorkbookTask({ type: 'inspect', buffer }, [buffer]);
                const inspection = await inspectionTask.promise;
                if (sequence !== inspectionSequence) return;
                applyInspection(inspection);
            } catch {
                if (sequence !== inspectionSequence) return;
                resetFileState();
                if (fileInput.value) fileInput.value.value = '';
                showFileError('The spreadsheet could not be read.');
            } finally {
                if (sequence === inspectionSequence) {
                    inspectionTask = null;
                    inspectionPending.value = false;
                }
            }
        };

        const handleFileSelected = async (e) => {
            const file = e.target.files[0];
            if (file) await inspectFile(file);
        };

        const handleFileDrop = async (e) => {
            dragOver.value = false;
            const file = e.dataTransfer.files[0];
            if (file) await inspectFile(file);
        };

        const clearFile = () => {
            cancelInspection();
            cancelTemplate();
            resetFileState();
            if (fileInput.value) {
                fileInput.value.value = '';
            }
        };

        const mappingReady = () => {
            if (!legacyMapping.value) return true;
            const values = Object.values(legacyMapping.value);
            return values.every(Number.isInteger) && new Set(values).size === values.length;
        };

        const formatBytes = (bytes, decimals = 2) => {
            if (bytes === 0) return '0 Bytes';
            const k = 1024;
            const dm = decimals < 0 ? 0 : decimals;
            const sizes = ['Bytes', 'KB', 'MB'];
            const i = Math.floor(Math.log(bytes) / Math.log(k));
            return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
        };

        const downloadTemplate = async () => {
            templateTask?.cancel();
            let currentTask = null;
            templatePending.value = true;
            try {
                currentTask = startCatalogWorkbookTask({ type: 'template' });
                templateTask = currentTask;
                const buffer = await currentTask.promise;
                if (templateTask !== currentTask) return;
                const url = URL.createObjectURL(new Blob([buffer], {
                    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
                }));
                const link = document.createElement('a');
                link.href = url;
                link.download = 'catalog_import_template.xlsx';
                link.click();
                URL.revokeObjectURL(url);
            } catch (error) {
                if (error?.name !== 'AbortError') showFileError('The template could not be created.');
            } finally {
                if (!currentTask || templateTask === currentTask) {
                    templateTask = null;
                    templatePending.value = false;
                }
            }
        };

        const startImport = async () => {
            if (!selectedFile.value || loading.value || inspectionPending.value || !mappingReady()) return;
            if (importMode.value === 'replace' && !replacementConfirmed.value) return;
            loading.value = true;

            const formData = new FormData();
            formData.append('file', selectedFile.value);
            formData.append('mode', importMode.value);
            if (importMode.value === 'replace') formData.append('confirm_replace', replacementConfirmed.value ? '1' : '0');
            if (legacyMapping.value) {
                formData.append('mapping', JSON.stringify(legacyMapping.value));
            }

            try {
                const { response, data } = await fetchJsonResponse('/api/admin/import/catalog', {
                    method: 'POST',
                    body: formData
                });
                if (response.ok) {
                    result.value = data;
                    if (data.success) emit('imported');
                } else {
                    if (window.showAdminAlert) window.showAdminAlert(data.message || 'Import failed.', 'error');
                    else alert(data.message || 'Import failed.');
                    loading.value = false;
                }
            } catch (e) {
                if (window.showAdminAlert) window.showAdminAlert(e.message || 'Connection error.', 'error');
                else alert(e.message || 'Connection error.');
                loading.value = false;
            }
        };

        const closeAndReload = () => emit('close');
        const cancelAndClose = () => {
            cancelInspection();
            cancelTemplate();
            emit('close');
        };

        registerCleanup(() => {
            cancelInspection();
            cancelTemplate();
        });

        return {
            selectedFile, fileInput, dragOver, loading, inspectionPending, templatePending, result,
            importMode, replacementConfirmed, legacyMapping, columnOptions, mappingFields,
            triggerFileInput, handleFileSelected, handleFileDrop, clearFile, mappingReady,
            formatBytes, downloadTemplate, startImport, closeAndReload, cancelAndClose
        };
}

export default {
    name: 'ImportModal',
    components: { ModalShell },
    emits: ['close', 'imported'],
    setup(props, { emit }) {
        return createImportModalState(emit);
    }
};
</script>
