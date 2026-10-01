import { setSessionEnding } from './sessionEnding.js';
import { fetchJson, fetchJsonResponseWithTimeout, fetchReadJsonResponse, waitAtMost } from '@/shared/http.js';
import { ref, computed } from 'vue';
import { t } from '@/shared/i18n.js';
import permissionPolicy from '@posapp/permission-policy';
import { clearPosOrderSessionStorage } from './posSessionStorage.js';
import { clearHeldOperationId, getHeldOperationId, readOrderSnapshot } from './stores/orderSession/orderSessionPersistence.js';

const activeUser = ref(null);
const activeShift = ref(null);
const isShiftChecking = ref(true);
// A failed check is not "no open shift": it keeps the register blocked
// (sales would carry no shift_id) until a retry succeeds.
const shiftCheckFailed = ref(false);
let shiftCheckPending = 0;
const showUserSidebar = ref(false);

const isOpeningShift = ref(false);
const startingCashInput = ref(0);
const previousShiftClosingCash = ref(null);

const showZReportModal = ref(false);
const showXReportModal = ref(false);
const zReportData = ref(null);
const actualCashInput = ref("");

const adminPinInput = ref("");

const isClosingShift = ref(false);

const isTempAdmin = ref(false);
const isActivatingOverride = ref(false);
const showOverrideModal = ref(false);
const overridePin = ref('');
const activeManagerPin = ref('');
const temporaryPermissions = ref([]);
let overrideTimer = null;
let shiftCheckRequestId = 0;
let startingCashEdited = false;

const userInitials = computed(() => {
    if (!activeUser.value || !activeUser.value.name) return "U";
    return activeUser.value.name.charAt(0).toUpperCase();
});

const hasAdminPrivilege = computed(() => {
    return activeUser.value?.role === 'admin' || activeUser.value?.role === 'programmer';
});

let dispatchToNodeSpoolerRef = null;
let getPrintMethodRef = () => 'browser';
let getReceiptPrinterIdRef = () => null;

export function useAuth({ dispatchToNodeSpooler, getPrintMethod, getReceiptPrinterId } = {}) {
    if (!activeUser.value && typeof sessionStorage !== 'undefined') {
        try { activeUser.value = JSON.parse(sessionStorage.getItem('pos_user') || 'null'); } catch (_) {}
    }

    if (dispatchToNodeSpooler) dispatchToNodeSpoolerRef = dispatchToNodeSpooler;
    else dispatchToNodeSpooler = dispatchToNodeSpoolerRef;

    if (getPrintMethod) getPrintMethodRef = getPrintMethod;
    else getPrintMethod = getPrintMethodRef;
    // Kept module-wide like the other terminal callbacks: dialogs such as the shift
    // report call useAuth() without arguments and must still send the chosen printer.
    if (getReceiptPrinterId) getReceiptPrinterIdRef = getReceiptPrinterId;
    else getReceiptPrinterId = getReceiptPrinterIdRef;

    const verifyManagerOverride = async (adminPin) => {
        const { data } = await fetchJsonResponseWithTimeout('api/auth/manager_override', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ admin_pin: adminPin })
        });
        if (!data.success) throw new Error(data.message || "Invalid manager PIN.");
        const permissions = Array.isArray(data.permissions) ? data.permissions.filter(key => permissionPolicy.TEMPORARY_CHECKOUT_PERMISSIONS.includes(key)) : [];
        if (!permissions.length) throw new Error('No temporary checkout approvals are enabled.');
        return permissions;
    };

    const checkActiveShift = async (userId = activeUser.value?.id) => {
        const requestId = ++shiftCheckRequestId;
        if (activeUser.value?.role === 'call_center') {
            activeShift.value = null;
            previousShiftClosingCash.value = null;
            isShiftChecking.value = false;
            return null;
        }
        if (activeShift.value || !userId) {
            previousShiftClosingCash.value = null;
            isShiftChecking.value = false;
            return activeShift.value;
        }
        previousShiftClosingCash.value = null;
        shiftCheckPending++;
        try {
            const { data } = await fetchReadJsonResponse(`api/auth/shifts?action=check&user_id=${userId}`);
            if (requestId !== shiftCheckRequestId) return activeShift.value;
            shiftCheckFailed.value = !data.success;
            if (data.success) {
                activeShift.value = data.data || data.shift || null;
                const reference = data.previous_shift_closing_cash;
                const numericReference = reference === null || reference === undefined
                    ? null
                    : Number(reference);
                previousShiftClosingCash.value = !activeShift.value
                    && Number.isFinite(numericReference)
                    && numericReference >= 0
                    ? numericReference
                    : null;
                if (!activeShift.value
                    && !startingCashEdited
                    && Object.prototype.hasOwnProperty.call(data, 'suggested_starting_cash')) {
                    const suggestion = Number(data.suggested_starting_cash);
                    startingCashInput.value = Number.isFinite(suggestion) && suggestion >= 0
                        ? suggestion
                        : 0;
                }
            }
            return activeShift.value;
        } catch (_) {
            if (requestId === shiftCheckRequestId) {
                previousShiftClosingCash.value = null;
                shiftCheckFailed.value = true;
            }
            return null;
        } finally {
            shiftCheckPending--;
            if (requestId === shiftCheckRequestId) isShiftChecking.value = false;
        }
    };

    // Driven by the socket heartbeat / Retry button: no request unless the last check failed.
    const retryFailedShiftCheck = () => (
        shiftCheckFailed.value && !shiftCheckPending ? checkActiveShift() : Promise.resolve(activeShift.value)
    );

    const markStartingCashEdited = () => {
        startingCashEdited = true;
    };

    const logout = async (reason = null) => {
        setSessionEnding(true);
        if (overrideTimer) { clearTimeout(overrideTimer); overrideTimer = null; }
        isTempAdmin.value = false;
        activeManagerPin.value = '';
        temporaryPermissions.value = [];
        const context = readOrderSnapshot(localStorage).context?.heldOrder;
        if (context?.id && context.claimToken && context.version) {
            const operationId = getHeldOperationId('release', context.id, localStorage);
            try {
                await waitAtMost(fetch(`api/pos/held_orders/${context.id}/release`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'same-origin',
                    keepalive: true,
                    body: JSON.stringify({
                        operation_id: operationId,
                        claim_token: context.claimToken,
                        expected_version: context.version,
                    }),
                }), 3000);
                clearHeldOperationId('release', context.id, localStorage);
            } catch (_) {}
        }
        // Call server next — this clears the httpOnly cookie AND invalidates the
        // token in the DB and in-memory cache. Without this, the cookie stays alive
        // and the router guard redirects the user back after the page loads.
        // keepalive: the request still reaches the server after we navigate away;
        // only the wait is bounded so a stalled link cannot freeze the Logout tap.
        await waitAtMost(fetch('api/auth/logout', { method: 'POST', keepalive: true }), 3000);
        sessionStorage.removeItem("pos_user");
        sessionStorage.removeItem("pos_token");
        sessionStorage.removeItem("pos_browser_approval_request_id");
        localStorage.removeItem("pos_token");
        localStorage.removeItem("pos_active_user_id");
        clearPosOrderSessionStorage();
        localStorage.removeItem("admin_current_page");
 
        // Hard reload (not router.push) — this is intentional and load-bearing.
        // It clears all Vue module-scope singleton state (useCart, useTables, useAuth refs).
        // The keep-alive cache in App.vue does NOT survive a full page reload.
        // DO NOT change to router.push without reading the invariant comment in useCart.js.
        const redirectPath = reason ? `/login?reason=${reason}` : '/login';
        if (typeof window.resetPosDialogs === 'function') window.resetPosDialogs();
        window.location.href = redirectPath;
    };

    const openMyShift = async () => {
        isOpeningShift.value = true;
        try {
            const { data } = await fetchJsonResponseWithTimeout('api/auth/shifts?action=open', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ user_id: activeUser.value.id, starting_cash: startingCashInput.value })
            });
            // Success, "already open" or any refusal: the server's shift state decides.
            if (data.success) startingCashEdited = false;
            if (!(await checkActiveShift()) && !data.success && !shiftCheckFailed.value) {
                await window.showPosAlert(data.message);
            }
        } catch (e) {
            // The open may have committed before the response was lost.
            if (!(await checkActiveShift()) && !shiftCheckFailed.value) {
                await window.showPosAlert("Network error while opening shift.");
            }
        } finally {
            isOpeningShift.value = false;
        }
    };

    const initiateZReport = async () => {
        try {
            const data = await fetchJson(`api/auth/shifts?action=zreport&shift_id=${activeShift.value.id}`);
            if (data.success) {
                zReportData.value = data.data;
                actualCashInput.value = data.data.actual_cash !== null && data.data.actual_cash !== undefined ? data.data.actual_cash : '';
                showZReportModal.value = true;
            } else {
                await window.showPosAlert(data.message || "Could not load the shift report.");
            }
        } catch (e) {
            await window.showPosAlert("Network error loading the shift report.");
        }
    };

    const initiateXReport = async () => {
        try {
            const data = await fetchJson(`api/auth/shifts?action=zreport&shift_id=${activeShift.value.id}`);
            if (data.success) {
                zReportData.value = data.data;
                showXReportModal.value = true;
            } else {
                await window.showPosAlert(data.message || "Could not load the shift report.");
            }
        } catch (e) {
            await window.showPosAlert("Network error loading the shift report.");
        }
    };

    const printXReportOnly = async (printMethod) => {
        if (printMethod === "browser") {
            document.body.classList.add('printing-shift-report');
            window.print();
            document.body.classList.remove('printing-shift-report');
        } else {
            await dispatchToNodeSpooler('x_report', zReportData.value);
        }
    };

    // Local finish of a committed close. The server revoked this user's sessions on
    // close, so this is logout's local cleanup (no api/auth/logout call, no timer,
    // no reload into a 401).
    // zReportQueued: the server's answer for a spooler Z report requested with the close
    // (undefined when not requested or when the close answer was lost).
    const finishClosedShift = async (zReportQueued) => {
        clearPosOrderSessionStorage();
        // Only admins/managers get the Z-report printout. Cashiers just close. Spooler
        // printing was queued by the close request itself (this session is now revoked).
        if (hasAdminPrivilege.value && getPrintMethod() === 'browser') {
            document.body.classList.add('printing-shift-report');
            window.print();
            document.body.classList.remove('printing-shift-report');
        } else if (zReportQueued === false) {
            await window.showPosAlert('Shift closed, but the Z report could not be sent to the printer. Print it from the shift reports.');
        }
        sessionStorage.removeItem("pos_user");
        localStorage.removeItem("pos_active_user_id");
        if (typeof window.resetPosDialogs === 'function') window.resetPosDialogs();
        window.location.href = '/login';
    };

    // A close whose answer was lost may still have committed. The server state decides:
    // a 401 means the close revoked this session; no open shift (or another one) means closed.
    const isShiftClosedOnServer = async (shiftId) => {
        try {
            const { response, data } = await fetchReadJsonResponse(`api/auth/shifts?action=check&user_id=${activeUser.value?.id}`, {}, 8000);
            if (response.status === 401) return true;
            if (!data?.success) return false;
            const open = data.data || data.shift || null;
            return !open || String(open.id) !== String(shiftId);
        } catch (_) {
            return false;
        }
    };

    const closeShiftAndPrint = async () => {
        if (isClosingShift.value) return;
        isClosingShift.value = true;
        try {
            const actualRaw = actualCashInput.value;
            if (actualRaw !== '' && actualRaw != null) {
                const actualNumber = Number(actualRaw);
                if (Number.isFinite(actualNumber) && actualNumber >= 0) {
                    const cents = v => Math.round(Number(v) * 100);
                    const startingCents = cents(zReportData.value.starting_cash);
                    const expectedCents = cents(zReportData.value.expected_cash);
                    const actualCents = cents(actualRaw);
                    if (startingCents > 0 && actualCents === expectedCents - startingCents) {
                        if (!(await window.showPosConfirm("You counted only this shift's sales. Count everything in the drawer, including the opening cash. Continue anyway?"))) {
                            return;
                        }
                    }
                }
            }
            setSessionEnding(true);
            const { data } = await fetchJsonResponseWithTimeout('api/auth/shifts?action=close', {
                method: 'PUT', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    shift_id: zReportData.value.shift_id,
                    expected_cash: zReportData.value.expected_cash,
                    actual_cash: actualCashInput.value,
                    // The close revokes this session, so the server queues the spooler Z report.
                    ...(hasAdminPrivilege.value && getPrintMethod() !== 'browser'
                        ? { print_z_report: true, receipt_printer_id: getReceiptPrinterId() || null }
                        : {}),
                })
            });
            if (data.success) {
                await finishClosedShift(data.z_report_print_queued);
            } else {
                setSessionEnding(false);
                await window.showPosAlert(data.message || "Could not close the shift.");
            }
        } catch (e) {
            const unanswered = ['TimeoutError', 'AbortError', 'TypeError', 'SyntaxError'].includes(e?.name);
            if (unanswered && await isShiftClosedOnServer(zReportData.value.shift_id)) {
                await finishClosedShift();
                return;
            }
            setSessionEnding(false);
            await window.showPosAlert(unanswered
                ? "The shift close was not confirmed. Check the connection and try again."
                : "Error closing shift.");
        } finally {
            isClosingShift.value = false;
        }
    };

    const closeShiftAuthorized = async () => {
        // Cashiers close their own shift directly — no manager PIN required.
        await closeShiftAndPrint();
    };

    const activateOverride = async () => {
        if (isActivatingOverride.value) return;
        const actorId = activeUser.value?.id;
        isActivatingOverride.value = true;
        try {
            const submittedPin = overridePin.value.trim();
            const approvedPermissions = await verifyManagerOverride(submittedPin);
            if (activeUser.value?.id !== actorId) return;
            activeManagerPin.value = submittedPin;
            temporaryPermissions.value = approvedPermissions;
            isTempAdmin.value = true;
            showOverrideModal.value = false;
            overridePin.value = '';
            if (overrideTimer) clearTimeout(overrideTimer);
            // Non-modal: a modal alert here would cancel any open confirm or prompt.
            overrideTimer = setTimeout(() => {
                isTempAdmin.value = false;
                activeManagerPin.value = '';
                temporaryPermissions.value = [];
                window.showPosToast?.(t("Manager Override has automatically expired."), 'warning');
            }, 5 * 60 * 1000);
        } catch (e) {
            await window.showPosAlert(e.message || "Invalid Manager PIN.");
            overridePin.value = '';
        } finally { isActivatingOverride.value = false; }
    };

    return {
        activeUser, activeShift, isShiftChecking, shiftCheckFailed, retryFailedShiftCheck, showUserSidebar,
        isOpeningShift, startingCashInput, previousShiftClosingCash,
        showZReportModal, showXReportModal, zReportData, actualCashInput, adminPinInput,
        isTempAdmin, isActivatingOverride, showOverrideModal, overridePin, activeManagerPin, temporaryPermissions,
        userInitials, hasAdminPrivilege, isClosingShift,
        logout, checkActiveShift, markStartingCashEdited, openMyShift, initiateZReport, initiateXReport, printXReportOnly, closeShiftAndPrint, closeShiftAuthorized, activateOverride
    };
}

