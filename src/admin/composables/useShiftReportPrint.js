import { ref } from 'vue';
import { t } from '@/shared/i18n.js';
import { useBrowserReportPrint } from './useBrowserReportPrint.js';

// Only Shifts uses this routing. Other pages keep their current print behavior.
export function useShiftReportPrint() {
    const browser = useBrowserReportPrint();
    const isPrinting = ref(false);
    const printReport = async (layout, provider) => {
        if (isPrinting.value || !['thermal', 'a4'].includes(layout)) return false;
        isPrinting.value = true;
        try {
            if (layout === 'a4') return await browser.printReport('a4', () => provider({}));
            const result = await provider({
                delivery: 'spooler',
                receipt_printer_id: localStorage.getItem('pos_receipt_printer_id') || '',
            });
            if (!result) return false;
            window.showAdminToast?.(t('Print job queued.'), 'success');
            return true;
        } catch (error) {
            console.error('Shift report printing failed:', error);
            await window.showAdminAlert(t('Printing failed.'));
            return false;
        } finally {
            isPrinting.value = false;
        }
    };
    return { printReport, isPrinting };
}
