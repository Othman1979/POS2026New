<template>
  <div :class="['pos-polish h-screen w-screen overflow-hidden bg-background font-sans no-select text-on-surface selection:bg-primary selection:text-white', { 'pos-theme-dark': isPosDark }]">
    <div id="pos-terminal-app" class="flex flex-col h-full w-full relative overflow-hidden">
      <div v-if="terminal.settingsError.value" class="shrink-0 flex items-center justify-between gap-3 px-4 py-2 bg-error-container text-on-error-container" role="alert">
        <span>{{ $t(terminal.settingsError.value) }}</span>
        <button type="button" class="font-bold underline" :disabled="terminal.settingsLoading.value" @click="terminal.loadSettings()">{{ $t('Retry') }}</button>
      </div>
      <div v-if="cart.pendingCheckout.value" class="shrink-0 flex items-center justify-between gap-3 px-4 py-2 bg-surface-container-high text-on-surface border-b border-outline-variant" role="status">
        <span>{{ $t('The last payment needs checking.') }}</span>
        <button type="button" class="font-bold underline" :disabled="cart.checkoutInFlight.value" @click="cart.openCheckoutModal()">{{ $t('Check last payment') }}</button>
      </div>
      <div v-else-if="cart.pendingCheckoutUnreadable.value" class="shrink-0 flex items-center justify-between gap-3 px-4 py-2 bg-surface-container-high text-on-surface border-b border-outline-variant" role="alert">
        <span>{{ $t('An unreadable checkout record was set aside. Check Orders for the last sale before charging it again.') }}</span>
        <button type="button" class="font-bold underline" @click="cart.dismissPendingCheckoutUnreadable()">{{ $t('Dismiss') }}</button>
      </div>

      <!-- Global Navigation Sidebar Overlay (Bidirectional) -->
      <!-- Backdrop Overlay -->
      <Transition name="fade">
        <div v-if="showUserSidebar" @click="showUserSidebar = false" class="sidebar-backdrop"></div>
      </Transition>

      <!-- Sidebar Drawer Panel -->
      <Transition :name="isRtl ? 'slide-sidebar-right' : 'slide-sidebar-left'">
        <div v-if="showUserSidebar"
          id="pos-user-sidebar"
          ref="userSidebarDialog"
          role="dialog"
          aria-modal="true"
          :aria-label="$t('Navigation')"
          tabindex="-1"
          :class="[
            'fixed inset-y-0 w-full max-w-[320px] sm:w-[340px] bg-surface-container z-[95] flex flex-col shadow-2xl border-outline-variant/40',
            isRtl ? 'right-0 left-auto border-l' : 'left-0 right-auto border-r'
          ]">

          <!-- Header: User identity -->
          <div class="p-5 border-b border-outline-variant/30 flex items-center justify-between shrink-0 bg-surface-container-high">
            <div class="flex items-center gap-3">
              <div class="w-11 h-11 rounded-full bg-primary/10 text-primary flex items-center justify-center font-bold text-sm">
                {{ userInitials }}
              </div>
              <div>
                <div class="font-bold text-sm text-on-surface" data-no-i18n>{{ activeUser?.name }}</div>
                <div class="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant mt-0.5">
                  {{ $t(activeUser?.role || '') }}
                </div>
              </div>
            </div>
            <button @click="showUserSidebar = false"
                    type="button"
                    :aria-label="$t('Close')"
                    class="w-8 h-8 rounded-lg text-on-surface-variant hover:bg-error/10 hover:text-error flex items-center justify-center transition-colors focus:outline-none">
              <i class="fa-solid fa-xmark text-sm" aria-hidden="true"></i>
            </button>
          </div>

          <!-- Body: Navigation -->
          <div class="flex-1 overflow-y-auto py-2">
            <a v-if="activeUser?.role === 'admin' || activeUser?.role === 'programmer'"
               href="/admin/dashboard" target="_blank"
               class="flex items-center gap-3.5 px-5 py-3 text-sm font-bold text-on-surface-variant hover:bg-primary/5 hover:text-primary transition-colors">
              <i class="fa-solid fa-gauge-high w-5 text-center"></i> {{ $t('Admin Dashboard') }}
            </a>
            <button v-if="tablesEnabled && can('tables.access') && activeUser?.role !== 'waiter' && activeUser?.role !== 'call_center'" @click="router.push('/tables'); showUserSidebar = false"
              class="w-full text-start flex items-center gap-3.5 px-5 py-3 text-sm font-bold text-on-surface-variant hover:bg-primary/5 hover:text-primary transition-colors">
              <i class="fa-solid fa-chair w-5 text-center"></i> {{ $t('Tables') }}
            </button>
            <button v-if="activeUser?.role !== 'call_center' && (can('pos.hold_orders') || can('orders.view'))" @click="router.push('/order-notes'); showUserSidebar = false"
              class="w-full text-start flex items-center gap-3.5 px-5 py-3 text-sm font-bold text-on-surface-variant hover:bg-primary/5 hover:text-primary transition-colors">
              <i class="fa-solid fa-clipboard-list w-5 text-center"></i> {{ $t('Order Notes') }}
            </button>
            <button v-if="activeUser?.role !== 'waiter' && activeUser?.role !== 'call_center'" @click="showTerminalSettings = true; showUserSidebar = false"
              class="w-full text-start flex items-center gap-3.5 px-5 py-3 text-sm font-bold text-on-surface-variant hover:bg-primary/5 hover:text-primary transition-colors">
              <i class="fa-solid fa-sliders w-5 text-center"></i> {{ $t('Terminal Setup') }}
            </button>
            <button type="button" class="drawer-theme-toggle w-full flex items-center justify-between gap-3 px-5 py-3 text-sm font-bold text-on-surface-variant hover:bg-primary/5 hover:text-primary transition-colors"
              :aria-pressed="isPosDark" @click="togglePosTheme">
              <span class="flex items-center gap-3.5">
                <i :class="['fa-solid w-5 text-center', isPosDark ? 'fa-sun' : 'fa-moon']" aria-hidden="true"></i>
                {{ $t(isPosDark ? 'Use light mode' : 'Use dark mode') }}
              </span>
              <span :class="['drawer-theme-indicator', { 'is-active': isPosDark }]" aria-hidden="true"><span></span></span>
            </button>

            <!-- Shift actions -->
            <div v-if="activeUser?.role !== 'waiter' && activeUser?.role !== 'call_center'" class="my-2 mx-5 border-t border-outline-variant/30"></div>
            <button v-if="hasAdminPrivilege" @click="initiateXReport(); showUserSidebar = false"
              class="w-full text-start flex items-center gap-3.5 px-5 py-3 text-sm font-bold text-on-surface-variant hover:bg-primary/5 hover:text-primary transition-colors">
              <i class="fa-solid fa-file-lines w-5 text-center"></i> {{ $t('X-Report') }}
            </button>
            <button v-if="activeUser?.role !== 'waiter' && activeUser?.role !== 'call_center' && can('shift.close')" @click="initiateZReport(); showUserSidebar = false"
              class="w-full text-start flex items-center gap-3.5 px-5 py-3 text-sm font-bold text-on-surface-variant hover:bg-error/10 hover:text-error transition-colors">
              <i class="fa-solid fa-cash-register w-5 text-center"></i> {{ $t('Close Shift') }}
            </button>
          </div>

          <!-- Footer: Logout -->
          <div class="p-4 border-t border-outline-variant/30 bg-surface-container-high shrink-0">
            <button @click="logout"
              class="w-full py-3 px-4 rounded-xl border border-error/25 text-error font-bold flex items-center justify-center gap-2 hover:bg-error/10 transition-colors focus:outline-none">
              <i class="fa-solid fa-arrow-right-from-bracket"></i> {{ $t('Logout') }}
            </button>
          </div>

        </div>
      </Transition>

      <Transition name="toast">
        <div v-if="scanMessage"
          role="status" aria-live="polite"
          class="fixed top-2 left-1/2 transform -translate-x-1/2 z-[100] bg-secondary-container text-on-secondary-container px-3 py-1.5 rounded-lg shadow-md flex items-center gap-2 text-xs font-bold border border-outline-variant/30">
          <i class="fa-solid fa-circle-check text-primary"></i> {{ scanMessage }}
        </div>
      </Transition>

      <div v-if="activeUser?.role === 'call_center' && !callCenterSession.started"
        class="call-center-intake-overlay fixed inset-0 z-[120] flex items-center justify-center p-3">
        <section ref="callCenterIntakeDialog" class="call-center-intake" role="dialog" aria-modal="true" aria-labelledby="call-center-intake-title" tabindex="-1">
          <header>
            <div>
              <span class="call-center-kicker">{{ $t('Call Center') }}</span>
              <h1 id="call-center-intake-title">{{ $t('New Phone Order') }}</h1>
            </div>
            <button type="button" class="call-center-logout" @click="logout">{{ $t('Logout') }}</button>
          </header>
          <div class="call-center-intake-grid">
            <label class="call-center-field call-center-field--phone">
              <span>{{ $t('Mobile No.') }}</span>
              <input v-model="customerPhone" data-dialog-initial-focus type="tel" inputmode="tel" enterkeyhint="search" placeholder="07..." data-no-i18n />
            </label>
            <button type="button" class="call-center-find" :disabled="callCenterSession.loading" @click="findCallCenterOrders">
              <i :class="['fa-solid', callCenterSession.loading ? 'fa-circle-notch fa-spin' : 'fa-magnifying-glass']"></i>
              {{ $t('Find active phone orders') }}
            </button>
            <label class="call-center-field call-center-field--name">
              <span>{{ $t('Name') }}</span>
              <input v-model="customerName" type="text" autocomplete="name" maxlength="100" />
            </label>
            <label class="call-center-field call-center-field--schedule">
              <span>{{ $t('Scheduled Date & Time') }}</span>
              <input v-model="orderDate" type="datetime-local" />
            </label>
            <label class="call-center-field call-center-field--address">
              <span>{{ $t('Address') }}</span>
              <input v-model="customerAddress" type="text" autocomplete="street-address" maxlength="500" />
            </label>
          </div>
          <p v-if="callCenterSession.error" class="call-center-error" role="alert">{{ $t(callCenterSession.error) }}</p>
          <div v-if="callCenterSession.matches.length" class="call-center-matches">
            <h2>{{ $t('Phone orders') }}</h2>
            <button v-for="match in callCenterSession.matches" :key="match.id" type="button" @click="continueCallCenterOrder(match)">
              <span>
                <strong data-no-i18n>{{ match.reference_name }}</strong>
                <small data-no-i18n>{{ match.customer_name }} · {{ match.item_count }} {{ $t('items') }}</small>
                <small v-if="match.call_center_user_name">
                  {{ $t('Call taken by') }}: <span data-no-i18n>{{ match.call_center_user_name }}</span>
                </small>
                <small>
                  {{ $t(match.kitchen_fired ? 'Kitchen sent' : 'Not sent') }}
                  <template v-if="Number(match.kitchen_dispatch_version) > 1">
                    · {{ $t('FOLLOW UP') }} #{{ Number(match.kitchen_dispatch_version) - 1 }}
                  </template>
                </small>
                <small v-if="match.claimed_by_user_id && match.claim_expires_at && new Date(match.claim_expires_at).getTime() > Date.now()">
                  {{ $t('Being edited') }}<span v-if="match.claim_owner_name" data-no-i18n>: {{ match.claim_owner_name }}</span>
                </small>
              </span>
              <span><small data-no-i18n>{{ match.delivery_date ? formatScheduledDateTime(match.delivery_date) : formatBusinessDateTime(match.updated_at) }}</small><b>{{ $t('Continue order') }}</b></span>
            </button>
          </div>
          <footer>
            <button type="button" class="call-center-start" @click="startCallCenterOrder">
              {{ $t('Start Order') }} <i class="fa-solid fa-arrow-right" aria-hidden="true"></i>
            </button>
          </footer>
        </section>
      </div>

      <div v-if="isShiftChecking || shiftCheckFailed" class="fixed inset-0 z-[100] bg-surface flex flex-col items-center justify-center" role="status">
        <i class="fa-solid fa-circle-notch fa-spin text-4xl text-primary mb-4"></i>
        <p class="text-xs font-bold tracking-wide text-on-surface-variant">{{ $t(shiftCheckFailed ? 'Could not check your shift. Retrying...' : 'Connecting...') }}</p>
        <button v-if="shiftCheckFailed" type="button" class="mt-3 font-bold underline text-primary" @click="retryFailedShiftCheck">{{ $t('Retry') }}</button>
      </div>

      <div v-if="!isShiftChecking && !shiftCheckFailed && !activeShift && activeUser?.role !== 'waiter' && activeUser?.role !== 'call_center' && can('shift.open')"
        class="shift-opening-overlay fixed inset-0 z-[100] bg-on-background/95 flex flex-col items-center justify-center p-4">
        <div
          ref="shiftOpeningDialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="shift-opening-title"
          aria-describedby="shift-opening-description"
          tabindex="-1"
          class="shift-opening-dialog bg-surface-container-lowest text-on-surface rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden border border-outline-variant/30 flex flex-col max-h-[90vh]">
          <div class="bg-inverse-surface px-5 py-4 border-b border-outline-variant/20 text-center shrink-0">
            <div class="w-12 h-12 bg-surface-container-low rounded-full flex items-center justify-center mx-auto mb-2">
              <i class="fa-solid fa-cash-register text-xl text-primary"></i>
            </div>
            <h1 id="shift-opening-title" class="text-base font-headline font-bold text-white tracking-tight">{{ $t('Open Register') }}</h1>
            <p id="shift-opening-description" class="text-[10px] text-surface-variant font-bold tracking-wide mt-1">{{ $t('Start your shift') }}</p>
          </div>
          <div class="p-5 overflow-y-auto premium-scroll flex-1">
            <p class="text-sm font-bold text-on-surface-variant mb-4 text-center">
              {{ $t('Welcome,') }} <span data-no-i18n>{{ activeUser?.name }}</span>!
            </p>
            <div v-if="previousShiftClosingCash !== null"
              class="mb-4 rounded-xl border border-outline-variant/40 bg-surface-container-low px-4 py-3 text-center">
              <p class="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant">
                {{ $t('Previous shift drawer closing balance') }}
              </p>
              <p class="mt-1 text-xl font-black text-on-surface" data-no-i18n>
                {{ previousShiftClosingCash.toFixed(2) }} JD
              </p>
              <p class="mt-1 text-[10px] leading-4 text-on-surface-variant">
                {{ $t('Starting cash is prefilled from the previous closing count. Count the drawer and correct it if different.') }}
              </p>
            </div>
            <label for="starting-cash-input" class="block text-[10px] font-bold text-on-surface-variant uppercase tracking-wider mb-2 text-center">
              {{ $t('Enter Starting Cash') }}
            </label>
            <div class="relative mb-5">
              <span class="absolute left-3 top-1/2 transform -translate-y-1/2 text-on-surface-variant font-bold text-lg">JD</span>
              <input id="starting-cash-input" v-model.number="startingCashInput" data-dialog-initial-focus @input="markStartingCashEdited" type="number" inputmode="decimal" enterkeyhint="done" step="0.01"
                class="w-full bg-surface-container-low border-none rounded-xl py-2.5 pl-12 pr-3 text-xl text-center font-black text-on-surface focus:outline-none focus:ring-2 focus:ring-primary transition-all shadow-inner"
                placeholder="0.00">
            </div>
          </div>
          <div class="p-4 border-t border-outline-variant/20 bg-surface-container-low shrink-0 flex gap-2">
            <button @click="logout"
              class="shift-opening-logout flex-1 py-3 bg-gray-200 text-gray-700 font-bold rounded-xl hover:bg-gray-300 transition-all duration-200 ease-out hover:scale-[1.02] active:scale-[0.98] text-[10px] uppercase tracking-widest">{{ $t('Logout') }}</button>
            <button @click="openMyShift" :disabled="isOpeningShift || startingCashInput === null || startingCashInput === ''"
              class="flex-1 py-3 bg-primary text-on-primary font-black rounded-xl shadow-md hover:bg-primary/90 disabled:opacity-50 transition-all duration-200 ease-out hover:scale-[1.02] active:scale-[0.98] text-[10px] uppercase tracking-widest flex justify-center items-center gap-2">
              <i v-if="isOpeningShift" class="fa-solid fa-circle-notch fa-spin"></i>
              <i v-else class="fa-solid fa-play"></i> {{ $t('Start Shift') }}
            </button>
          </div>
        </div>
      </div>

      <div class="flex-1 flex min-h-0 h-full w-full relative" style="transform: translate3d(0,0,0); backface-visibility: hidden; -webkit-backface-visibility: hidden;">
        <PosCatalogWorkspace
          :is-fullscreen="isFullscreen"
          :fullscreen-enabled="fullscreenEnabled"
          :is-dark-mode="isPosDark"
          @toggle-fullscreen="toggleFullscreen"
        />
        <PosCartWorkspace
          :is-importing-qr-draft="isImportingQrDraft"
          :active-held-count="activeHeldCount"
          @table-action="handleCartTableAction"
          @review-qr="showQrComparisonModal = true"
          @import-qr="importQrDraft"
          @dismiss-qr="dismissQrDraft"
          @open-more-actions="showMoreActionsModal = true"
        />
      </div>

      <!-- MODALS AND OVERLAYS -->

      <!-- Checkout Modal -->
      <CheckoutModal v-if="showCheckoutModal" />

      <!-- More Actions Modal -->
      <Transition name="pos-modal">
        <div v-if="!isCallCenter && showMoreActionsModal"
          class="terminal-functions-backdrop fixed inset-0 z-[80] flex items-center justify-center p-4 no-select">
        <section
          ref="moreActionsDialog"
          class="terminal-functions-modal modal-panel"
          role="dialog"
          aria-modal="true"
          aria-labelledby="order-actions-title"
          tabindex="-1"
        >
          <header class="terminal-functions-header modal-header">
            <h3 id="order-actions-title">{{ $t('Order Actions') }}</h3>
            <button @click="showMoreActionsModal = false"
              type="button"
              class="terminal-functions-close modal-close"
              :aria-label="$t('Close')">
              <span aria-hidden="true">×</span>
            </button>
          </header>
          <div class="terminal-functions-grid modal-body">
            <button v-if="canPrintCheck" @click="printGuestCheck" :disabled="guestCheckInFlight || cartItems.length === 0"
              type="button"
              class="function-tile">
              <span>{{ $t('Print Guest Check') }}</span>
            </button>

            <button v-if="serviceChargeEnabled && canApplyServiceCharge" @click="addServiceCharge" :disabled="cartItems.length === 0"
              type="button"
              class="function-tile">
              <span>{{ $t('Add Service Charge') }}</span>
              <span class="function-tile-meta" dir="ltr" data-no-i18n>{{ serviceChargePercentage }}%</span>
            </button>
            <button v-if="canTaxExempt" @click="toggleTaxExempt(); showMoreActionsModal = false" :disabled="cartItems.length === 0"
              type="button"
              class="function-tile"
              :class="{ 'is-active': isTaxExempt }">
              <span>{{ $t(isTaxExempt ? 'Tax Exempt: ON' : 'Tax Exempt: OFF') }}</span>
            </button>
            <button @click="openNoteModal('order'); showMoreActionsModal = false"
              type="button"
              class="function-tile">
              <span>{{ $t('Order Note') }}</span>
            </button>
            <button v-if="canApplyDiscount" @click="openDiscountModal('order'); showMoreActionsModal = false"
              type="button"
              class="function-tile">
              <span>{{ $t('Order Discount') }}</span>
            </button>
            <button v-if="['cashier', 'admin', 'programmer'].includes(activeUser?.role)"
              type="button"
              class="function-tile"
              :disabled="isOpeningCashDrawer"
              @click="handleOpenCashDrawer">
              <span>{{ $t('No Sale (Open Drawer)') }}</span>
            </button>
            <button v-if="can('pos.expenses')"
              type="button"
              class="function-tile"
              :disabled="!activeShift"
              @click="showMoreActionsModal = false; showExpenseModal = true">
              <span>{{ $t('Record expense') }}</span>
              <span v-if="!activeShift" class="function-tile-meta">{{ $t('Open a shift first') }}</span>
            </button>
            <button @click="showOverrideModal = true; showMoreActionsModal = false"
              :disabled="activeUser?.role === 'admin' || activeUser?.role === 'programmer'"
              type="button"
              class="function-tile function-tile--wide"
              :class="{ 'is-active': isTempAdmin }">
              <span>
                {{ activeUser?.role === 'admin' || activeUser?.role === 'programmer' ? $t('Manager Access Active') : isTempAdmin ? $t('Checkout approval active') : $t('Approve checkout changes') }}
              </span>
            </button>
          </div>
          </section>
        </div>
      </Transition>

      <ExpenseModal
        v-if="!isCallCenter && showExpenseModal"
        :open="!isCallCenter && showExpenseModal"
        :is-dark-mode="isPosDark"
        :receipt-printer-id="localPrinterId"
        @close="showExpenseModal = false"
        @saved="handleExpenseSaved"
      />




      <!-- Split Check Modal -->
      <SplitCheckModal v-if="!isCallCenter && showSplitModal" />

      <!-- QR Cart Comparison Modal -->
      <div v-if="!isCallCenter && showQrComparisonModal" class="fixed inset-0 z-[90] flex items-center justify-center bg-on-background/80 p-4 no-select">
        <div ref="qrComparisonDialog" role="dialog" aria-modal="true" aria-labelledby="qr-comparison-title" tabindex="-1" class="bg-surface-container-lowest w-full max-w-xl rounded-2xl shadow-2xl flex flex-col overflow-hidden border border-outline-variant/30 max-h-[85vh]">
          <!-- Header -->
          <div class="px-4 py-3 border-b border-outline-variant/30 flex justify-between items-center bg-surface-container-low shrink-0">
            <h3 id="qr-comparison-title" class="font-headline font-bold text-on-surface text-sm tracking-tight flex items-center gap-2">
              <i class="fa-solid fa-mobile-screen-button text-primary"></i> {{ $t('Review QR Customer Cart') }}
            </h3>
            <button type="button" @click="closeQrComparisonDialog" :disabled="isImportingQrDraft" :aria-label="$t('Close')" class="text-on-surface-variant hover:text-error transition-colors disabled:opacity-50">
              <i class="fa-solid fa-xmark text-lg" aria-hidden="true"></i>
            </button>
          </div>
          
          <!-- Content -->
          <div class="p-4 overflow-y-auto premium-scroll flex-1 bg-surface space-y-4">
            <div class="grid grid-cols-2 gap-4">
              <!-- Left: Waiter Terminal Cart -->
              <div class="border border-outline-variant/30 rounded-xl p-3 bg-white text-start">
                <h4 class="text-[10px] font-black text-gray-500 uppercase tracking-widest mb-3 pb-1 border-b">{{ $t('Current Active Cart') }}</h4>
                <div v-if="cartItems.length === 0" class="text-xs text-gray-400 font-semibold py-8 text-center">
                  {{ $t('Cart is empty') }}
                </div>
                <div v-else class="space-y-2 max-h-[250px] overflow-y-auto styled-scroll pr-1">
                  <div v-for="item in cartItems" :key="item.id" class="flex justify-between items-center text-xs py-1 border-b border-gray-50">
                    <span :class="['font-bold text-gray-700 truncate max-w-[120px]', { 'font-arabic': isArabic(item.name) }]"><span data-no-i18n>{{ item.name }}</span></span>
                    <span class="font-bold text-gray-500">x{{ item.qty }}</span>
                  </div>
                </div>
              </div>

              <!-- Right: QR Customer Draft Cart -->
              <div class="border border-blue-200 rounded-xl p-3 bg-blue-50/30 text-start">
                <h4 class="text-[10px] font-black text-blue-800 uppercase tracking-widest mb-3 pb-1 border-b border-blue-100">{{ $t('QR Customer Cart') }}</h4>
                <div class="space-y-2 max-h-[250px] overflow-y-auto styled-scroll pr-1">
                  <div v-for="item in activeQrDraft" :key="item.product_id" class="flex justify-between items-center text-xs py-1 border-b border-blue-100/50">
                    <span :class="['font-bold text-blue-900 truncate max-w-[120px]', { 'font-arabic': isArabic(item.name) }]"><span data-no-i18n>{{ item.name }}</span></span>
                    <span class="font-black text-blue-700">x{{ item.qty }}</span>
                  </div>
                </div>
              </div>
            </div>

            <div class="bg-surface-container-low rounded-xl p-3 text-[11px] text-on-surface-variant font-semibold text-start">
              {{ $t('Importing will merge the QR customer cart into your active cart. Existing items will have their quantities updated, and new items will be added.') }}
            </div>
          </div>

          <!-- Footer -->
          <div class="p-3 border-t border-outline-variant/30 bg-surface-container-low shrink-0 flex gap-2">
            <button @click="closeQrComparisonDialog" :disabled="isImportingQrDraft" class="flex-1 py-2.5 bg-gray-200 text-gray-700 font-black rounded-xl hover:bg-gray-300 transition-all text-[10px] uppercase tracking-widest disabled:opacity-50">
              {{ $t('Cancel') }}
            </button>
            <button @click="importQrDraft" :disabled="isImportingQrDraft" class="flex-1 py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-black rounded-xl shadow-md transition-all text-[10px] uppercase tracking-widest disabled:opacity-50 disabled:cursor-not-allowed">
              {{ $t('Merge & Import') }}
            </button>
          </div>
        </div>
      </div>

      <!-- Note / Discount Modal -->
      <CartNotesModal v-if="activeModal === 'note' || activeModal === 'discount'" />

      <!-- Assign Course Modal -->
      <div v-if="!isCallCenter && showCourseModal"
        class="fixed inset-0 z-[80] flex items-center justify-center bg-on-background/80 no-select p-4">
        <div ref="courseDialog" role="dialog" aria-modal="true" aria-labelledby="assign-course-title" tabindex="-1" class="bg-surface-container-lowest w-full max-w-sm rounded-2xl shadow-2xl flex flex-col overflow-hidden border border-outline-variant/30">
          <div class="px-6 py-4 border-b border-outline-variant/30 flex justify-between items-center bg-surface-container-low shrink-0">
            <h3 id="assign-course-title" class="font-headline font-bold text-on-surface text-sm sm:text-base tracking-tight">{{ $t('Assign Course') }}</h3>
            <button type="button" @click="showCourseModal = false" :aria-label="$t('Close')" class="text-on-surface-variant hover:text-error transition-colors">
              <i class="fa-solid fa-xmark text-lg sm:text-xl" aria-hidden="true"></i>
            </button>
          </div>
          <div class="p-5 sm:p-6 bg-surface-container-lowest flex flex-col gap-3">
            <button v-for="course in courses" :key="course.id" @click="setItemCourse(course)"
              class="p-4 sm:p-5 bg-surface-container-low rounded-xl border border-outline-variant/30 hover:border-primary hover:text-primary hover:bg-primary-fixed/30 transition-colors text-start font-bold text-on-surface text-sm sm:text-base flex justify-between items-center shadow-sm">
              <span>{{ $t(course.name) }}</span><i class="fa-solid fa-arrow-right-long opacity-50 text-lg sm:text-xl"></i>
            </button>
            <button @click="clearItemCourse"
              class="mt-2 sm:mt-3 p-4 sm:p-5 rounded-xl border border-dashed border-outline-variant hover:bg-surface-container-high transition-colors text-center text-on-surface-variant font-bold text-xs sm:text-sm uppercase tracking-widest">
              {{ $t('Fire Immediately (No Course)') }}
            </button>
          </div>
        </div>
      </div>

      <!-- Extra Modals -->
      <ModifierSelectorModal v-if="showModifierModal" />
      <ShiftReportModal v-if="!isCallCenter && (showZReportModal || showXReportModal)" />
      <TerminalSettingsModal v-if="!isCallCenter && showTerminalSettings" />
      <PrivilegesModal v-if="!isCallCenter && showOverrideModal" />
      <ReceiptPreviewModal v-if="!isCallCenter && showReceiptModal" />
      <!-- Always mounted: its teleported .receipt-print-wrapper is what browser printing prints. -->
      <ReceiptPrintLayout v-if="!isCallCenter" />


      <!-- Table Action Manager PIN Modal -->
      <transition name="pos-modal">
        <div v-if="!isCallCenter && showTablePinModal" class="fixed inset-0 bg-on-background/90 z-[110] flex items-center justify-center p-4 no-select">
          <div ref="tablePinDialog" role="dialog" aria-modal="true" aria-labelledby="table-pin-title" tabindex="-1" class="modal-panel w-full max-w-xs bg-surface-container-lowest rounded-2xl shadow-2xl border border-outline-variant/30 overflow-hidden flex flex-col">
            <div class="p-5 text-center flex flex-col items-center">
              <div class="w-12 h-12 rounded-full bg-amber-100 border border-amber-200 text-amber-700 flex items-center justify-center mb-3">
                <i class="fa-solid fa-shield-halved text-lg"></i>
              </div>
              <h3 id="table-pin-title" class="text-sm font-bold text-on-surface tracking-tight mb-2">{{ $t('Manager Authorization') }}</h3>
              <p class="text-[9px] font-semibold text-on-surface-variant uppercase tracking-widest mb-4">{{ $t('Enter Manager PIN to continue') }}</p>
              <input
                v-model="tablePinInput"
                data-dialog-initial-focus
                type="password"
                inputmode="numeric"
                enterkeyhint="done"
                pattern="[0-9]*"
                maxlength="10"
                :aria-label="$t('Manager PIN')"
                class="w-full text-center text-2xl font-mono tracking-widest border border-outline-variant/40 rounded-lg py-2 focus:border-primary outline-none mb-2"
                placeholder="••••"
                @keyup.enter="submitTablePin"
              />
              <p v-if="tablePinError" class="text-error text-[9px] font-bold mb-4 uppercase tracking-wider">{{ tablePinError }}</p>
              <div class="w-full flex gap-2 mt-2">
                <button @click="closeTablePinDialog"
                  class="flex-1 h-9 bg-surface-container-high hover:bg-surface-container-highest text-on-surface-variant font-bold text-[10px] uppercase tracking-wider rounded-lg transition-colors">
                  {{ $t('Cancel') }}
                </button>
                <button @click="submitTablePin"
                  class="flex-1 h-9 bg-primary hover:bg-primary/90 text-on-primary font-black text-[10px] uppercase tracking-wider rounded-lg transition-colors">
                  {{ $t('Submit') }}
                </button>
              </div>
            </div>
          </div>
        </div>
      </transition>

    </div>
  </div>
</template>

<script>
export default {
  name: 'PosTerminal'
}
</script>

<script setup>
import { formatScheduledDateTime, formatBusinessDateTime } from '@/utils/businessDate.js';
import { ref, computed, onMounted, onUnmounted, watch, onActivated, onDeactivated } from 'vue';
import { t, currentLanguage, getDirection } from '@/shared/i18n.js';
import { useRouter } from 'vue-router';
import { useAuth } from '@/pos/useAuth.js';

const isRtl = computed(() => getDirection(currentLanguage.value) === 'rtl');
import { useProducts } from '@/pos/useProducts.js';
import { useTables, isLeavingTable, clearLeavingTable } from '@/pos/useTables.js';
import { useTerminal } from '@/pos/useTerminal.js';
import { useCart } from '@/pos/useCart.js';
import { useSocket } from '@/pos/useSocket.js';
import { createStockChangeRefresh } from '@/pos/stockChangeRefresh.js';
import { createKeepAliveRefreshTracker } from '@/pos/keepAliveRefreshTracker.js';
import { planActivationCartRefresh } from '@/pos/activationCartRefresh.js';
import { startIdleTracker } from '@/pos/useIdleTracker.js';
import { usePermissions } from '@/pos/usePermissions.js';
import { usePosDialogFocus } from '@/pos/usePosDialogFocus.js';
import { lazyPosComponent } from '@/pos/lazyPosComponent.js';
import { preloadRoute, scheduleIdlePreload } from '@/pos/idlePreload.js';
import {
  cartDisagreesWithCatalogRows,
  chunkProductIds,
  collectCartCatalogProductIds,
  requestedIdsCoverCurrentDraft,
  syncCategoryPrices,
} from '@/pos/categoryPriceSync.js';
import {
  clearTablePrefill,
  clearHeldOrderHandoff,
  readHeldOrderHandoff,
  hasPendingTableSession as hasStoredTableSession,
  readActiveTableSession,
} from '@/pos/posSessionStorage.js';
import { shouldLoadTableWorkspace, tableRowEndsSession } from '@/pos/tableWorkspacePolicy.js';

import PosCatalogWorkspace from './pos/PosCatalogWorkspace.vue';
import PosCartWorkspace from './pos/PosCartWorkspace.vue';
import ReceiptPrintLayout from './pos/ReceiptPrintLayout.vue';
import { isArabic } from '../utils/orderNotesFormat.js';

const loadCheckoutModal = () => import('./pos/CheckoutModal.vue');
const loadModifierSelectorModal = () => import('./pos/ModifierSelectorModal.vue');
const loadCartNotesModal = () => import('./pos/CartNotesModal.vue');

const loadSplitCheckModal = () => import('./pos/SplitCheckModal.vue');
const loadShiftReportModal = () => import('./pos/ShiftReportModal.vue');
const loadTerminalSettingsModal = () => import('./pos/TerminalSettingsModal.vue');
const loadPrivilegesModal = () => import('./pos/PrivilegesModal.vue');
const loadExpenseModal = () => import('./pos/ExpenseModal.vue');

// Runs at idle after the boot, so it reads the settled role and permissions:
// only what this user can open is fetched.
const preloadHotDialogs = () => {
  const role = auth.activeUser.value?.role;
  if (role === 'call_center') return [loadCheckoutModal(), loadModifierSelectorModal(), loadCartNotesModal()];
  return [
    loadCheckoutModal(),
    loadModifierSelectorModal(),
    loadCartNotesModal(),
    loadSplitCheckModal(),
    loadShiftReportModal(),
    loadTerminalSettingsModal(),
    loadPrivilegesModal(),
    can('pos.expenses') && loadExpenseModal(),
    role !== 'waiter' && tablesEnabled.value && can('tables.access') && preloadRoute(router, '/tables'),
    (can('pos.hold_orders') || can('orders.view')) && preloadRoute(router, '/order-notes'),
  ];
};
let cancelHotDialogPreload = () => {};
const scheduleHotDialogPreload = () => {
  cancelHotDialogPreload();
  cancelHotDialogPreload = scheduleIdlePreload(preloadHotDialogs);
};
const isActive = ref(false);
const showExpenseModal = ref(false);
const isOpeningCashDrawer = ref(false);
const POS_THEME_STORAGE_KEY = 'pos_theme';
const isPosDark = ref(localStorage.getItem(POS_THEME_STORAGE_KEY) === 'dark');
const isFullscreen = ref(Boolean(document.fullscreenElement));
const activeHeldCount = ref(0);
const fullscreenEnabled = computed(() => Boolean(document.fullscreenEnabled));

const togglePosTheme = () => {
  isPosDark.value = !isPosDark.value;
  localStorage.setItem(POS_THEME_STORAGE_KEY, isPosDark.value ? 'dark' : 'light');
};

const syncFullscreenState = () => {
  isFullscreen.value = Boolean(document.fullscreenElement);
};

const toggleFullscreen = async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch (error) {
    console.error('Failed to change fullscreen mode:', error);
    window.showPosToast?.(t('Fullscreen is unavailable in this browser.'), 'warning');
  }
};

const handleExpenseSaved = (_expense, printQueued) => {
  if (!window.showPosToast) return;
  window.showPosToast(
    printQueued ? t('Expense recorded.') : t('Expense saved, but it could not be sent to the printer.'),
    printQueued ? 'success' : 'warning'
  );
};


const handleOpenCashDrawer = async () => {
  if (isOpeningCashDrawer.value) return;
  isOpeningCashDrawer.value = true;
  try {
    await openCashDrawer(localPrinterId.value);
  } finally {
    isOpeningCashDrawer.value = false;
  }
};

// Helper to calculate contrast text colors & dark shadow dynamic styles based on custom background color
const router = useRouter();

let terminalRef = null;
const { socket, initSocket, connectionGeneration } = useSocket();

const auth = useAuth({
  dispatchToNodeSpooler: async (type, data) => {
    if (terminalRef) await terminalRef.dispatchToNodeSpooler(type, data);
  },
  getPrintMethod: () => {
    return terminalRef?.printMethod?.value || 'browser';
  },
  getReceiptPrinterId: () => terminalRef?.localPrinterId?.value || null
});

const products = useProducts();
const tables = useTables();
const terminal = useTerminal({ salesContext: products.salesContext });
terminalRef = terminal;

const cart = useCart();

const { can } = usePermissions();

// Destructure reactive variables & functions from useAuth
const {
  activeUser, activeShift, isShiftChecking, shiftCheckFailed, retryFailedShiftCheck, showUserSidebar,
  isOpeningShift, startingCashInput, previousShiftClosingCash,
  showZReportModal, showXReportModal, zReportData, actualCashInput, adminPinInput,
  isTempAdmin, showOverrideModal, overridePin,
  userInitials, hasAdminPrivilege,
  logout, openMyShift, markStartingCashEdited, initiateZReport, initiateXReport
} = auth;

// Destructure reactive variables & functions from useProducts
const {
  products: rawProducts, fetchData, setSalesContext, salesContext
} = products;

// Destructure reactive variables & functions from useTables
const {
  activeTable, activeQrDraft, restaurantTables,
  tablesEnabled, closeTable, disjoinTable,
  showSplitModal,
  activeMode, activeModeSourceTable, joinSelectedChildIds, loadActiveTableOrder, loadActiveTableDraft, dismissActiveQrDraft,
  clearActiveTableSession
} = tables;

// Destructure reactive variables & functions from useTerminal
const {
  showTerminalSettings, barcodeEnabled, scanMessage,
  localPrinterId, showReceiptModal
} = terminal;

const canLoadTableWorkspace = ({ settingsReadSucceeded = terminal.settingsLoaded.value } = {}) => shouldLoadTableWorkspace({
  role: auth.activeUser.value?.role,
  canAccessTables: can('tables.access'),
  tablesEnabled: terminal.tablesEnabledSetting.value,
  settingsReadSucceeded,
  hasPendingTableSession: hasStoredTableSession(localStorage, activeTable.value),
});

// Destructure reactive variables & functions from useCart
const {
  cart: cartItems, showCheckoutModal, isProcessing,
  courses, showCourseModal, showModifierModal,
  importQrDraftItems,
  openNoteModal, setItemCourse, clearItemCourse, openDiscountModal, addServiceCharge,
  openCashDrawer,
  showMoreActionsModal,
  activeModal, numpadInput, numpadMode, printGuestCheck, guestCheckInFlight,
  cancelQuickAmount,
  serviceChargeEnabled, serviceChargePercentage, canApplyServiceCharge, canApplyDiscount, canPrintCheck,
  isTaxExempt, canTaxExempt, toggleTaxExempt,
  customerPhone, customerName, customerAddress, orderDate, callCenterSession,
  isCallCenter,
  initializeCallCenterSession, startCallCenterOrder, findCallCenterOrders, continueCallCenterOrder
} = cart;

// Failed optional chunks close their own workflow and leave the order/cart in
// shared stores. The global Vue error handler then provides the visible retry
// guidance without trapping the user behind a modal that could not mount.
const CheckoutModal = lazyPosComponent(loadCheckoutModal, () => { showCheckoutModal.value = false; });
const ModifierSelectorModal = lazyPosComponent(loadModifierSelectorModal, () => { cart.cancelModifiers(); });
const CartNotesModal = lazyPosComponent(loadCartNotesModal, () => { activeModal.value = null; });
const SplitCheckModal = lazyPosComponent(loadSplitCheckModal, () => { showSplitModal.value = false; });
const ShiftReportModal = lazyPosComponent(loadShiftReportModal, () => {
  showZReportModal.value = false;
  showXReportModal.value = false;
});
const TerminalSettingsModal = lazyPosComponent(loadTerminalSettingsModal, () => { showTerminalSettings.value = false; });
const PrivilegesModal = lazyPosComponent(loadPrivilegesModal, () => { showOverrideModal.value = false; });
const ReceiptPreviewModal = lazyPosComponent(() => import('./pos/ReceiptPreviewModal.vue'), () => { showReceiptModal.value = false; });
const ExpenseModal = lazyPosComponent(loadExpenseModal, () => { showExpenseModal.value = false; });

const showTablePinModal = ref(false);
const tablePinInput = ref('');
const tablePinError = ref('');
const tablePinCallback = ref(null);
const userSidebarDialog = ref(null);
const callCenterIntakeDialog = ref(null);
const moreActionsDialog = ref(null);
const qrComparisonDialog = ref(null);
const courseDialog = ref(null);
const tablePinDialog = ref(null);
const shiftOpeningDialog = ref(null);

const closeTablePinDialog = () => {
  showTablePinModal.value = false;
  tablePinCallback.value = null;
};

const promptTablePin = (callback) => {
  tablePinCallback.value = callback;
  tablePinInput.value = '';
  tablePinError.value = '';
  showTablePinModal.value = true;
};

const submitTablePin = () => {
  const pin = tablePinInput.value.trim();
  if (!pin) {
    tablePinError.value = t("PIN is required.");
    return;
  }
  const callback = tablePinCallback.value;
  tablePinCallback.value = null;
  showTablePinModal.value = false;
  callback?.(pin);
};

const handlePosTransferClick = () => {
  if (!activeTable.value) return;
  activeMode.value = 'transfer';
  activeModeSourceTable.value = tables.captureTableActionSource(activeTable.value);
  router.push('/tables');
};

const handlePosJoinClick = () => {
  if (!activeTable.value) return;
  activeMode.value = 'join';
  activeModeSourceTable.value = activeTable.value;
  joinSelectedChildIds.value = [];
  router.push('/tables');
};

const executePosDisjoin = async (tableIds, pin = null) => {
  isProcessing.value = true;
  const res = await disjoinTable(tableIds, pin);
  if (!cart.checkoutInFlight.value) isProcessing.value = false;
  if (res.success) {
    window.showPosToast?.(t(res.message), "success");
    // The workflow refreshed seating metadata. Its bill and local draft did not
    // change, so reopening the saved bill would discard unsaved cart edits.
  } else if (res.pinRequired) {
    promptTablePin((enteredPin) => {
      executePosDisjoin(tableIds, enteredPin);
    });
  } else {
    await window.showPosAlert(t(res.message));
  }
};

const handlePosDisjoinClick = () => {
  if (!activeTable.value) return;
  const table = activeTable.value;
  if (table.seating_parent_id) {
    executePosDisjoin([table.id]);
  } else {
    const children = restaurantTables.value.filter(t => t.seating_parent_id === table.id).map(t => t.id);
    if (children.length > 0) {
      executePosDisjoin(children);
    }
  }
};

const handleCartTableAction = (action) => {
  if (action === 'transfer') return handlePosTransferClick();
  if (action === 'join') return handlePosJoinClick();
  if (action === 'disjoin') return handlePosDisjoinClick();
};

let tableContextRequestId = 0;
watch(activeTable, async (newVal) => {
  if (!isActive.value) return; // don't react while cached on the floor plan
  const requestId = ++tableContextRequestId;
  const nextContext = newVal ? 'table' : 'register';
  const contextChanged = salesContext.value !== nextContext;
  setSalesContext(nextContext);
  // Leaving for the floor: the POS deactivates next, and the next activation
  // owns the catalog. Only an in-place release (cashier stays on /pos) reads.
  // The flag covers only this change, so a blocked navigation cannot silence
  // a later in-place release.
  const leaving = isLeavingTable();
  clearLeavingTable();
  if (!newVal && leaving) return;
  if (contextChanged) {
    await fetchData({ preferCache: true });
    if (requestId !== tableContextRequestId) return;
    if (!isActive.value || salesContext.value !== nextContext) return;
  }

  const currentTable = activeTable.value;
  if (!currentTable && activeUser.value?.role === 'waiter') {
    router.push('/tables');
  }

  if (currentTable) {
    if (terminal.teardownBarcodeListener) {
      terminal.teardownBarcodeListener();
    }
  } else {
    if (terminal.setupBarcodeListener) {
      terminal.setupBarcodeListener(products.products, cart.addToCart);
    }
  }
});

const showQrComparisonModal = ref(false);
const isImportingQrDraft = ref(false);
const closeQrComparisonDialog = () => {
  if (!isImportingQrDraft.value) showQrComparisonModal.value = false;
};
const isShiftOpening = computed(() => (
  !isShiftChecking.value
  && !shiftCheckFailed.value
  && !activeShift.value
  && activeUser.value?.role !== 'waiter'
  && activeUser.value?.role !== 'call_center'
  && can('shift.open')
));

usePosDialogFocus({ open: showUserSidebar, dialog: userSidebarDialog, onEscape: () => { showUserSidebar.value = false; } });
usePosDialogFocus({ open: () => isCallCenter.value && !callCenterSession.value.started, dialog: callCenterIntakeDialog });
usePosDialogFocus({ open: isShiftOpening, dialog: shiftOpeningDialog });
usePosDialogFocus({ open: showMoreActionsModal, dialog: moreActionsDialog, onEscape: () => { showMoreActionsModal.value = false; } });
usePosDialogFocus({ open: showQrComparisonModal, dialog: qrComparisonDialog, onEscape: closeQrComparisonDialog });
usePosDialogFocus({ open: showCourseModal, dialog: courseDialog, onEscape: () => { showCourseModal.value = false; } });
usePosDialogFocus({ open: showTablePinModal, dialog: tablePinDialog, onEscape: closeTablePinDialog });

const importQrDraft = async () => {
  if (!activeQrDraft.value || activeQrDraft.value.length === 0) return;
  // In-flight guard: a second click before dismissQrDraft resolves would re-import the
  // same draft (mergeScanned sums quantities -> doubled order). (Task 7)
  if (isImportingQrDraft.value) return;
  isImportingQrDraft.value = true;

  try {
    // Every refusal already told the waiter why; the draft stays for another try.
    const result = await importQrDraftItems(rawProducts.value);
    if (!result.success) return;
    showQrComparisonModal.value = false;

    if (result.dismissed === 'ok') {
      window.showPosToast?.(t("QR Customer Cart imported successfully!"), "success");
    } else if (result.dismissed === 'failed') {
      // Retried on the next heartbeat/reconnect; the same draft is never offered again.
      window.showPosToast?.(t("QR items were added to the cart, but the QR order could not be cleared yet. It will be cleared when the connection returns."), "warning");
    }
  } catch (err) {
    console.error("Failed to import QR customer cart:", err);
    await window.showPosAlert(t("Failed to import QR cart. Please try again."));
  } finally {
    isImportingQrDraft.value = false;
  }
};

const dismissQrDraft = async () => {
  if (!activeTable.value?.id) return;
  await dismissActiveQrDraft(activeTable.value.id);
};

const syncCartAvailabilityFromCatalog = () => {
  for (const item of cartItems.value) {
    if (item.product_id == null && item.id == null) continue;
    const product = rawProducts.value.find(entry => String(entry.id) === String(item.product_id ?? item.id));
    if (!product) continue;
    item.is_available = Number(product.is_available ?? 1);
    item.can_sell = Number(product.can_sell ?? product.is_available ?? 1);
    item.price_override_locked = Number(product.price_override_locked) || 0;
  }
};

let priceRefreshRequestId = 0;
let priceRefreshRetryQueued = false;
const schedulePriceRefreshRetry = (refreshPrices) => {
  if (priceRefreshRetryQueued || !isActive.value) return;
  priceRefreshRetryQueued = true;
  queueMicrotask(() => {
    priceRefreshRetryQueued = false;
    if (isActive.value) void refreshCartCatalogPrices({ refreshPrices });
  });
};

// Set when the last cart-price refresh failed; retried by retryFailedReads.
// Checkout re-prices from the DB, so a stale line would fail Pay (or sell at the
// old price for override-capable users) until fresh prices land.
let cartPricesStale = null;
const cartPriceContextKey = () => `${salesContext.value}:${activeTable.value?.id ?? ''}`;
const refreshCartCatalogPrices = async ({ refreshPrices = true } = {}) => {
  const productIds = collectCartCatalogProductIds(cartItems.value);
  if (!['register', 'table'].includes(salesContext.value) || activeTable.value?.is_split || !productIds.length) {
    cartPricesStale = null;
    return;
  }
  const requestId = ++priceRefreshRequestId;
  const capturedSalesContext = salesContext.value;
  const capturedTableId = activeTable.value?.id ?? null;
  const markStale = () => {
    if (requestId === priceRefreshRequestId) cartPricesStale = { key: `${capturedSalesContext}:${capturedTableId ?? ''}`, refreshPrices };
  };
  try {
    const results = [];
    for (const chunk of chunkProductIds(productIds)) {
      results.push(await products.resolveCategoryPrices(chunk, capturedSalesContext));
    }
    if (results.some(({ response, data }) => !response.ok || !data.success)) {
      markStale();
      return;
    }
    if (requestId !== priceRefreshRequestId || salesContext.value !== capturedSalesContext) return;
    if ((activeTable.value?.id ?? null) !== capturedTableId || activeTable.value?.is_split) return;

    const currentProductIds = collectCartCatalogProductIds(cartItems.value);
    if (!requestedIdsCoverCurrentDraft(productIds, currentProductIds)) {
      schedulePriceRefreshRetry(refreshPrices);
      return;
    }

    const resolvedProducts = results.flatMap(({ data }) => data.products || []);
    const { repairedNoteSelections } = syncCategoryPrices(cartItems.value, resolvedProducts, { refreshPrices });
    cartPricesStale = null;
    if (repairedNoteSelections > 0) {
      window.showPosToast?.(t('A priced note changed or is unavailable. Refresh and re-add it.'), 'warning');
    }
  } catch (_) {
    // Checkout remains authoritative; a transient refresh failure must not
    // disrupt a sale. The next heartbeat/focus retries it.
    markStale();
  }
};

// preferCache paints the cached scope and revalidates it in the background;
// the revalidation bumps catalogRevalidations, which re-syncs cart prices.
const refreshCatalogAndCart = async ({ refreshCartPrices = true, preferCache = false } = {}) => {
  await products.fetchData(preferCache ? { preferCache: true } : { forceFull: true });
  syncCartAvailabilityFromCatalog();
  await refreshCartCatalogPrices({ refreshPrices: refreshCartPrices });
};

// The deferred read covers the loaded scope; which cached scopes go stale is
// decided from the pending change (see stockChangeRefresh.js).
const stockRefresh = createStockChangeRefresh({ products, afterRead: syncCartAvailabilityFromCatalog });

// A stale cached category paints before its revalidation lands; a line added in
// that window must not keep the pre-refresh price or availability. Prices are
// re-resolved only when the fresh rows cannot confirm every unsaved cart line,
// so a revalidation that confirms the cart sends no request.
watch(products.catalogRevalidations, () => {
  if (!isActive.value) return;
  const loaded = new Set(rawProducts.value.map(row => String(row.id)));
  if (!collectCartCatalogProductIds(cartItems.value).some(id => loaded.has(String(id)))) return;
  syncCartAvailabilityFromCatalog();
  if (cartDisagreesWithCatalogRows(cartItems.value, rawProducts.value)) void refreshCartCatalogPrices();
});

const onInventoryChanged = async (payload, { refreshCartPrices = true } = {}) => {
  // Availability has its own targeted event. All unknown events retain the
  // conservative full refresh for older or mixed-version servers.
  if (payload?.scope === 'availability') return;
  if (payload?.scope === 'stock') {
    // A stock event naming its products reloads only when one is on screen (or a
    // read that may predate it is in flight); other cached scopes holding one are
    // marked stale. Cart availability reads the loaded rows, so the cart needs no
    // check of its own. No ids means the affected set is unknown: reload.
    if (Array.isArray(payload.productIds) && payload.productIds.length) stockRefresh.noteNamed(payload.productIds);
    else stockRefresh.noteUnscoped();
    return;
  }
  if (payload?.scope === 'catalog' && Array.isArray(payload.productIds) && payload.productIds.length) {
    await products.revalidateCatalogScopes();
    syncCartAvailabilityFromCatalog();
    const changed = new Set(payload.productIds.map(String));
    if (collectCartCatalogProductIds(cartItems.value).some(id => changed.has(String(id)))) {
      await refreshCartCatalogPrices({ refreshPrices: refreshCartPrices });
    }
    return;
  }
  await refreshCatalogAndCart();
};

const canObserveHeldOrders = () => (
  auth.activeUser.value?.role !== 'call_center' && can('pos.hold_orders')
);
let heldSummaryFailed = false;
let heldSummaryRequest = null;
let heldSummarySeq = 0;
// Callers join an in-flight read; `fresh` (a change event or reconnect) starts a
// new one, because a read that began before the change can miss it. Only the
// newest read writes the badge. getHeldOrdersSummary carries the read deadline.
const fetchHeldOrderSummary = ({ fresh = false } = {}) => {
  if (!canObserveHeldOrders()) {
    heldSummarySeq++;
    heldSummaryFailed = false;
    activeHeldCount.value = 0;
    return Promise.resolve();
  }
  if (heldSummaryRequest && !fresh) return heldSummaryRequest;
  const seq = ++heldSummarySeq;
  const request = (async () => {
    let failed = true;
    let count;
    try {
      const { response, data } = await cart.getHeldOrdersSummary();
      failed = !(response.ok && data.success);
      if (!failed) count = Math.max(0, Number(data.active_register_count) || 0);
    } catch (_) {
      // A stale badge must never interrupt taking an order; retryFailedReads fixes it.
    }
    if (seq !== heldSummarySeq) return;
    heldSummaryFailed = failed;
    if (!failed) activeHeldCount.value = count;
  })().finally(() => { if (heldSummaryRequest === request) heldSummaryRequest = null; });
  heldSummaryRequest = request;
  return request;
};

// Heartbeat/focus recovery for reads that failed while the socket stayed up.
// Each check is a flag test, so a healthy terminal sends no request.
const retryFailedReads = () => {
  if (!isActive.value) return;
  void cart.probePendingCheckout({ heartbeat: true });
  if (activeTable.value?.id) void dismissActiveQrDraft(activeTable.value.id, { retryImported: true });
  products.retryFailedCatalog();
  if (heldSummaryFailed) void fetchHeldOrderSummary();
  if (tables.tableWorkspaceLoadFailed.value && !tables.isTableWorkspaceLoading.value && canLoadTableWorkspace()) {
    void tables.loadTableWorkspace({ force: true });
  }
  if (cartPricesStale) {
    // A different order context owns its own refresh; the old failure is moot.
    if (cartPricesStale.key === cartPriceContextKey()) void refreshCartCatalogPrices({ refreshPrices: cartPricesStale.refreshPrices });
    else cartPricesStale = null;
  }
};

const seenPhoneHoldEvents = new Set();
let heldSummaryRefreshTimer = null;
const onHeldOrdersChanged = (payload) => {
  if (!canObserveHeldOrders()) return;
  const eventId = payload?.source === 'call_center' && Number(payload?.held_order_id) > 0
    ? Number(payload.held_order_id)
    : null;
  if (eventId && !seenPhoneHoldEvents.has(eventId)) {
    seenPhoneHoldEvents.add(eventId);
    if (seenPhoneHoldEvents.size > 100) seenPhoneHoldEvents.delete(seenPhoneHoldEvents.values().next().value);
    window.showPosToast?.(t('New phone order received'), 'info');
  }
  // The badge counts register holds only (no table, no parent bill), and no event
  // moves a hold between table and register, so table and split events cannot change it.
  if (payload?.table_id != null || payload?.parent_invoice_id != null) return;
  if (heldSummaryRefreshTimer) clearTimeout(heldSummaryRefreshTimer);
  heldSummaryRefreshTimer = setTimeout(() => fetchHeldOrderSummary({ fresh: true }), 120);
};

const onProductAvailabilityChanged = (payload) => {
  // A product may exist in both a parent-category snapshot and its own
  // subcategory snapshot. Drop those snapshots and overlay the event on any
  // pending reconnect response so the recovery read remains authoritative.
  products.applyProductAvailabilityChanges(payload?.products);
  for (const change of payload?.products || []) {
    for (const item of cartItems.value) {
      if (String(item.product_id ?? item.id) !== String(change.product_id)) continue;
      item.is_available = Number(change.is_available);
      item.can_sell = Number(change.can_sell);
    }
  }
};

const onSettingsChanged = (payload) => {
  const settingsRefresh = terminal.loadSettings({ force: true });
  // Catalog-owned settings arrive with the settings read above. Stock policy also
  // changes each row's projected stock, so cached rows revalidate; categories do
  // not change. Unscoped events still require full recovery.
  if (!payload?.keys?.length) products.fetchData({ forceFull: true });
  else if (payload.keys.some(key => ['stock_enabled', 'recipe_ledger_enabled'].includes(key))) {
    void products.revalidateCatalogScopes();
  }
  if (payload?.keys?.includes('first_shift_starting_cash')) void reconcileOpeningShiftReference();
  if (payload?.keys?.some(key => ['default_order_type_id', 'order_types'].includes(key))) {
    cart.fetchOrderTypes({ force: true });
  }
  if (payload?.keys?.includes('tables_enabled') && auth.activeUser.value?.role !== 'call_center'
    && (auth.activeUser.value?.role === 'waiter' || can('tables.access'))) {
    void settingsRefresh.then(() => tables.loadTableWorkspace({ force: true }));
  }
  if (payload && payload.keys && payload.keys.includes('store_icon')) {
    import('@/shared/faviconInjector.js').then(({ injectStoreFavicon }) => {
      injectStoreFavicon();
    });
  }
};

// After a checkout settles without ending the table session (it failed), run the vacate
// check once against the current row that the update handler skipped while it was in flight.
const vacateActiveTableIfFreed = () => {
  // A new, unsaved table has no order that anyone could have vacated.
  if (!activeTable.value?.id || !activeTable.value.current_order_id) return;
  const row = restaurantTables.value.find((t) => String(t.id) === String(activeTable.value.id));
  if (tableRowEndsSession(activeTable.value.current_order_id, row)) closeTable({ router });
};
watch(() => cart.checkoutInFlight.value, (inFlight) => { if (!inFlight) vacateActiveTableIfFreed(); });

let tableUpdateTimeout = null;
const onTableUpdate = (payload) => {
  if (payload && payload.action === 'update_single_table' && payload.table) {
    const idx = restaurantTables.value.findIndex((t) => t.id === payload.table.id);
    if (idx !== -1) {
      restaurantTables.value[idx] = { ...restaurantTables.value[idx], ...payload.table };
    }
    if (activeTable.value && String(activeTable.value.id) === String(payload.table.id)) {
      // The table I'm working on was vacated elsewhere (remote void/checkout). Tear down
      // my stale session so I don't keep a dead cart or resume into a freed table; the
      // floor plan is where I should land. Otherwise just merge the fresh table fields.
      if (tableRowEndsSession(activeTable.value.current_order_id, payload.table)) {
        // Vacated, or reassigned to a DIFFERENT order elsewhere (transfer/swap): merging
        // the new current_order_id would let my next save overwrite that order, so leave
        // the table for the floor plan. While this till's own checkout is in flight the row
        // may be its own echo or a reopen: keep the session so the response finishes the
        // sale; the checkout watcher re-checks the current row once it settles.
        if (!cart.checkoutInFlight.value) closeTable({ router });
      } else {
        activeTable.value = { ...activeTable.value, ...payload.table };
      }
    }
    // A full read already in flight may carry an older row; queue one follow-up read.
    if (tables.isTableWorkspaceLoading.value) void tables.loadTableWorkspace({ force: true, skipActivation: true });
    return;
  }
  if (tableUpdateTimeout) clearTimeout(tableUpdateTimeout);
  tableUpdateTimeout = setTimeout(() => {
    if (canLoadTableWorkspace()) tables.loadTableWorkspace({ force: true });
  }, 250);
};

const onTableDraftChanged = ({ tableId, itemCount }) => {
  const tbl = restaurantTables.value.find((t) => t.id === tableId);
  if (tbl) {
    tbl.qr_draft_count = itemCount;
  }
  if (activeTable.value && activeTable.value.id === tableId) {
    loadActiveTableDraft(tableId); // guarded against a mid-flight table switch
  }
};

const checkAndRestoreHeldOrder = async (isMounting = false) => {
  const restoredHeldOrder = readHeldOrderHandoff(localStorage);
  const urlParams = new URLSearchParams(window.location.search);
  const editId = urlParams.get('edit_invoice');

  let activeTableObj = readActiveTableSession(localStorage);
  if (!activeTableObj) activeTableObj = activeTable.value;

  const isSplit = activeTableObj?.is_split;
  const hasPendingTableSession = hasStoredTableSession(localStorage, activeTable.value) && !isSplit;

  if (restoredHeldOrder) {
    const owner = cart.captureOrderSession();
    const snapshot = () => JSON.stringify(['cart', 'orderNote', 'orderDiscount', 'customerName', 'customerPhone', 'customerAddress', 'orderDate', 'selectedOrderType', 'hashNumber'].map(key => cart[key].value));
    const draft = snapshot();
    try {
      if (cart.checkoutInFlight.value || isProcessing.value || cart.isHolding.value) return 'deferred-held-order';
      if (cart.cart.value.length && !await window.showPosConfirm?.(t('Replace the current draft with this held order?'))) return 'deferred-held-order';
      if (!cart.isCurrentOrderSession(owner) || draft !== snapshot()) return 'deferred-held-order';
      let restorePayload = restoredHeldOrder;
      let restoredFromServer = false;
      if (restoredHeldOrder.heldOrderId && restoredHeldOrder.claimToken) {
        const { response, data } = await cart.claimHeldOrderForHandoff({
          id: restoredHeldOrder.heldOrderId,
          claimToken: restoredHeldOrder.claimToken,
          expectedVersion: restoredHeldOrder.expectedVersion,
        });
        if (!response.ok || !data.success || !data.order) throw new Error(data.message || 'Could not recover suspended ticket.');
        const claimed = data.order;
        const hasServerCartData = claimed.cart_data !== null && claimed.cart_data !== undefined && claimed.cart_data !== '';
        const cartData = hasServerCartData ? claimed.cart_data : (restoredHeldOrder.cartData || '{}');
        const parsed = typeof cartData === 'string' ? JSON.parse(cartData) : cartData;
        restorePayload = Array.isArray(parsed) ? { items: parsed } : parsed;
        restorePayload.reference_name ||= claimed.reference_name || '';
        restorePayload.service_charge_snapshot = claimed.service_charge_snapshot || null;
        restorePayload.held_order_context = {
          id: Number(claimed.id || restoredHeldOrder.heldOrderId),
          reference: claimed.reference_name || '',
          version: Number(data.claim?.version || claimed.version || restoredHeldOrder.expectedVersion),
          claimToken: data.claim?.claimToken || restoredHeldOrder.claimToken,
          claimExpiresAt: data.claim?.claimExpiresAt || claimed.claim_expires_at || null,
          kitchenFired: claimed.kitchen_fired === 1 || claimed.kitchen_fired === true,
          baselineUnknown: (claimed.kitchen_fired === 1 || claimed.kitchen_fired === true) && !claimed.kitchen_baseline_known,
          kitchenDispatchVersion: Number(claimed.kitchen_dispatch_version || 0),
        };
        restoredFromServer = hasServerCartData;
      }
      if (cart.checkoutInFlight.value || cart.isHolding.value || !cart.isCurrentOrderSession(owner) || draft !== snapshot()) {
        window.showPosToast?.(t('The current draft changed. Restore the held order again when ready.'), 'warning');
        return 'deferred-held-order';
      }
      // Leaving any table to restore a held order is a session-end boundary: use the
      // canonical teardown so an in-flight table load/draft is invalidated and the QR
      // draft can't bleed into this non-table session. (clearCart defaults false — the
      // held order's cart is set right below.)
      clearActiveTableSession();
      clearTablePrefill(localStorage);
      // Single canonical restore path (Task 1): resets edit residue, normalizes
      // numerics, and defaults every field. Pre-migration array payloads wrap as { items }.
      cart.restoreHeldOrder(Array.isArray(restorePayload) ? { items: restorePayload } : restorePayload);
      clearHeldOrderHandoff(localStorage);
      if (window.showPosToast) {
        window.showPosToast(t("Suspended ticket loaded successfully!"), "success");
      }
      return restoredFromServer ? 'server-canonical-held' : 'local-held-order';
    } catch (e) {
      console.error("Failed to restore held order from localStorage:", e);
      window.showPosToast?.(t("Held order could not be restored. Your current draft was kept."), "warning");
      return 'failed-held-order';
    }
  } else if (editId) {
    // Opening an edit-invoice also leaves any table session — same canonical teardown.
    clearActiveTableSession();
    clearTablePrefill(localStorage);
    cart.loadOrderForEditing(editId);
    return 'edit-invoice';
  } else if (isMounting && !hasPendingTableSession) {
    cart.loadSavedOrder();
    return 'local-saved-order';
  }
  return 'none';
};

onMounted(async () => {
  document.addEventListener('fullscreenchange', syncFullscreenState);
  syncFullscreenState();
  const userStr = sessionStorage.getItem("pos_user");
  if (userStr) {
    try {
      auth.activeUser.value = JSON.parse(userStr);
      if (auth.activeUser.value?.role === 'call_center') {
        initializeCallCenterSession(auth.activeUser.value);
      }
    } catch (parseErr) {
      console.error("Failed to parse user session:", parseErr);
      window.location.href = '/login';
      return;
    }

    // Subscribe before taking the initial HTTP snapshot. A slow first socket
    // connection can otherwise leave a mutation-sized gap after that snapshot.
    window.addEventListener('socket_reconnected', handleSocketReconnected);
    try {
      bindCatalogSocketListeners();
    } catch (socketErr) {
      console.error("Failed to initialize POS catalog Socket listeners:", socketErr);
    }
    const urlParams = new URLSearchParams(window.location.search);
    const editId = urlParams.get('edit_invoice');
    const hasPendingTableSession = hasStoredTableSession(localStorage, activeTable.value);
    const shouldCheckShift = auth.activeUser.value?.role !== 'waiter' || hasPendingTableSession;
    const activeShiftRequest = shouldCheckShift ? auth.checkActiveShift() : null;
    // The catalog read depends only on the sales context, so it need not wait for
    // settings, the restore or the shift check. A held handoff or edit_invoice may
    // leave the table (context change) and a table-less waiter goes to /tables:
    // those keep the ordered path below.
    const startsCatalogEarly = !readHeldOrderHandoff(localStorage) && !editId
      && !(auth.activeUser.value?.role === 'waiter' && !hasPendingTableSession);
    let earlyCatalogRead = null;
    if (startsCatalogEarly) {
      setSalesContext(activeTable.value ? 'table' : 'register');
      initialCatalogSnapshotStarted = true;
      earlyCatalogRead = products.fetchData({ forceFull: true });
    }

    const settingsLoaded = await terminal.loadSettings();

    let restoreOutcome = 'none';
    if (auth.activeUser.value?.role !== 'call_center') {
      restoreOutcome = await checkAndRestoreHeldOrder(true);
      if (auth.activeUser.value?.role === 'waiter' && !hasPendingTableSession) {
        router.push('/tables');
        return;
      }
    }

    await (activeShiftRequest || auth.checkActiveShift());

    // Bootstrap Application Data
    setSalesContext(activeTable.value ? 'table' : 'register');
    const restoredBeforeMount = cart.consumeServerCanonicalRestore();
    const heldSummaryRequest = fetchHeldOrderSummary();
    cart.fetchOrderTypes();
    initialCatalogSnapshotStarted = true;
    const refreshCartPrices = restoreOutcome !== 'server-canonical-held' && !restoredBeforeMount;
    if (earlyCatalogRead) {
      // The restored cart still re-syncs against the fresh catalog.
      await earlyCatalogRead;
      syncCartAvailabilityFromCatalog();
      await refreshCartCatalogPrices({ refreshPrices: refreshCartPrices });
    } else {
      await refreshCatalogAndCart({ refreshCartPrices });
    }
    initialCatalogSnapshotComplete = true;
    if (initialConnectReconcilePending) {
      initialConnectReconcilePending = false;
      await reconcileInitialSnapshot();
    }
    await heldSummaryRequest;
    if (canLoadTableWorkspace({ settingsReadSucceeded: settingsLoaded })) {
      await tables.loadTableWorkspace({ skipActivation: !!editId });
    }
    // A reconnect during boot: the catalog was reconciled above; refresh the rest
    // now, or on the next activation if the terminal was parked meanwhile.
    if (bootReconnectRecoveryPending && isActive.value) {
      bootReconnectRecoveryPending = false;
      await recoverAfterReconnect({ refreshCatalog: false });
    }

    scheduleHotDialogPreload();

    // No-op here; socket listeners and barcode hooks are registered dynamically in onActivated

  } else {
    router.push('/login');
  }
});

let initialCatalogSnapshotStarted = false;
let initialCatalogSnapshotComplete = false;
let bootReconnectRecoveryPending = false;
let hasSeenSocketConnect = false;
let initialRecoveryRefreshStarted = false;
let initialConnectReconcilePending = false;
const onSocketConnect = () => {
  const isFirstConnect = !hasSeenSocketConnect;
  hasSeenSocketConnect = true;
  if (!isFirstConnect || !initialCatalogSnapshotStarted) return;
  if (!initialCatalogSnapshotComplete) {
    initialConnectReconcilePending = true;
    return;
  }
  // useSocket emits socket_reconnected synchronously first when this connect
  // follows an error. Let that authoritative recovery own the refresh.
  queueMicrotask(() => { void reconcileInitialSnapshot(); });
};

// The first connect closes the gap between the boot snapshot and the socket
// subscription. The server answers after joining 'staff', so an equal catalog
// generation proves nothing changed in that gap; any doubt reads again.
const reconcileInitialSnapshot = async () => {
  if (initialRecoveryRefreshStarted) return;
  if (await isCatalogGenerationCurrent()) return;
  if (!initialRecoveryRefreshStarted) await refreshCatalogAndCart();
};

// True only when the server proves the loaded catalog is current. An older
// server, a timeout or a missing token all answer false so the caller reads.
const isCatalogGenerationCurrent = async () => {
  const snapshotGeneration = products.catalogGeneration.value;
  if (!snapshotGeneration) return false;
  try {
    return (await initSocket().timeout(5000).emitWithAck('catalog_generation')) === snapshotGeneration;
  } catch (_) {
    return false;
  }
};

// Reconnect and reactivation recovery: a blip that changed nothing reads nothing.
// The cart half still runs on a match: availability re-syncs from the loaded rows,
// and a cart restored from its local backup (repriceOnMatch) is re-priced once.
const refreshCatalogUnlessCurrent = async ({ repriceOnMatch = false, ...options } = {}) => {
  // A matching token proves nothing about reads that already failed locally.
  if (products.catalogLoadError.value || !(await isCatalogGenerationCurrent())) return refreshCatalogAndCart(options);
  syncCartAvailabilityFromCatalog();
  const stale = cartPricesStale;
  if (repriceOnMatch || (stale && stale.key === cartPriceContextKey())) await refreshCartCatalogPrices({ refreshPrices: repriceOnMatch || stale.refreshPrices });
};

const bindCatalogSocketListeners = () => {
  const s = initSocket();
  s.off('inventory_changed', onInventoryChanged);
  s.on('inventory_changed', onInventoryChanged);
  s.off('product_availability_changed', onProductAvailabilityChanged);
  s.on('product_availability_changed', onProductAvailabilityChanged);
  s.off('shifts_changed', onShiftLifecycleChanged);
  s.on('shifts_changed', onShiftLifecycleChanged);
  s.off('connect', onSocketConnect);
  s.on('connect', onSocketConnect);
  // The server's heartbeat (every 25 s) proves it is reachable: retry settings
  // only if the last read failed. Adds no request while settings are fine.
  s.io.off('ping', terminal.retryFailedSettings);
  s.io.on('ping', terminal.retryFailedSettings);
  s.io.off('ping', retryFailedShiftCheck);
  s.io.on('ping', retryFailedShiftCheck);
  s.io.off('ping', retryFailedReads);
  s.io.on('ping', retryFailedReads);
  if (s.connected) onSocketConnect();
  return s;
};


const reconcileOpeningShiftReference = async () => {
  if (activeShift.value || activeUser.value?.role === 'waiter' || activeUser.value?.role === 'call_center' || !can('shift.open')) return;
  await auth.checkActiveShift();
};

const onShiftLifecycleChanged = (payload) => {
  if (payload?.action !== 'open' && payload?.action !== 'close') return;
  void reconcileOpeningShiftReference();
};

const handleSocketReconnected = async () => {
  // During boot, a catalog read already in flight (the early read starts before
  // the shift check) must not be aborted by a second one: the first-connect
  // generation check closes its gap once it lands. Reads that may have finished
  // before the drop (settings, a QR draft) get the rest of the recovery when
  // boot completes; a catalog read not started yet will be fresh anyway.
  if (!initialCatalogSnapshotComplete) {
    if (initialCatalogSnapshotStarted) initialConnectReconcilePending = true;
    bootReconnectRecoveryPending = true;
    return;
  }
  // Parked on /tables: activation refreshes by connection generation.
  if (!isActive.value) return;
  initialRecoveryRefreshStarted = true;
  await recoverAfterReconnect({ refreshCatalog: true });
};

const recoverAfterReconnect = async ({ refreshCatalog }) => {
  void cart.probePendingCheckout();
  // table_draft_changed events missed while offline: reload the QR draft so an
  // import never uses (and then dismisses) a stale copy.
  if (activeTable.value?.id) loadActiveTableDraft(activeTable.value.id);
  // Force a fresh read: joining one that started before the reconnect would
  // return its failure. Settings go first because table gating needs them;
  // the rest are independent, bounded, and each failure keeps its own retry
  // path, so one slow read must not hold back the others.
  const settingsReadSucceeded = await terminal.loadSettings({ force: true });
  await Promise.allSettled([
    refreshCatalog ? refreshCatalogUnlessCurrent() : null,
    cart.fetchOrderTypes({ force: true }),
    fetchHeldOrderSummary({ fresh: true }),
    reconcileOpeningShiftReference(),
    canLoadTableWorkspace({ settingsReadSucceeded }) ? tables.loadTableWorkspace({ force: true }) : null,
  ]);
};

const handleWindowFocus = async () => {
  if (!isActive.value) return;
  terminal.retryFailedSettings();
  void retryFailedShiftCheck();
  // Events keep held counts and shifts current; retry only reads that failed.
  retryFailedReads();
};

// While this page is kept alive but inactive, socket events only mark the
// affected resource dirty; reactivation refreshes exactly those resources, or
// everything when the connection generation changed (reconnect/never observed).
const refreshTracker = createKeepAliveRefreshTracker();
const onInactiveInventoryChanged = payload => refreshTracker.markInventoryChanged(payload);
const onInactiveAvailabilityChanged = onProductAvailabilityChanged;
const onInactiveSettingsChanged = () => refreshTracker.markDirty('settings');
const onInactiveHeldOrdersChanged = () => refreshTracker.markDirty('held');
const onInactiveShiftsChanged = () => refreshTracker.markDirty('shift');

let hasSeenInitialActivation = false;
onActivated(async () => {
  isActive.value = true;
  clearLeavingTable();
  void cart.probePendingCheckout();
  cancelQuickAmount();
  if (socket.value) {
    socket.value.off('inventory_changed', onInactiveInventoryChanged);
    socket.value.off('product_availability_changed', onInactiveAvailabilityChanged);
    socket.value.off('settings_changed', onInactiveSettingsChanged);
    socket.value.off('held_orders_changed', onInactiveHeldOrdersChanged);
    socket.value.off('shifts_changed', onInactiveShiftsChanged);
  }
  // Keep the shared catalog aligned even when this kept-alive page was off-screen
  // while a table session changed.
  const nextContext = activeTable.value ? 'table' : 'register';
  const contextChanged = salesContext.value !== nextContext;
  setSalesContext(nextContext);
  const isReactivation = hasSeenInitialActivation;
  const refresh = isReactivation ? refreshTracker.activate(connectionGeneration.value) : null;
  hasSeenInitialActivation = true;
  // A boot-time reconnect whose recovery waited while the terminal was parked:
  // deactivation recorded the already-bumped generation, so the tracker cannot see it.
  if (isReactivation && bootReconnectRecoveryPending) {
    bootReconnectRecoveryPending = false;
    void recoverAfterReconnect({ refreshCatalog: false });
  }
  // Clear stale UI before yielding to reads. A late activation response must
  // not dismiss a payment dialog or clear input opened during that request.
  products.searchQuery.value = '';
  numpadInput.value = '';
  numpadMode.value = 'qty'; // Default Mode
  
  // Close any potentially open overlays/modals
  showCheckoutModal.value = false;
  showCourseModal.value = false;
  showModifierModal.value = false;
  showReceiptModal.value = false;
  showMoreActionsModal.value = false;
  showExpenseModal.value = false;
  showTablePinModal.value = false;
  showQrComparisonModal.value = false;
  
  // Reset the activeModal (used for note/discount overlays)
  activeModal.value = null;

  // Clear any stale processing flag. The waiter table-save path intentionally
  // leaves isProcessing=true during the redirect to /tables (keepProcessingOnSuccess)
  // to avoid spinner flicker; since isProcessing is a module-level singleton it would
  // otherwise stay true and leave the Update button stuck spinning on re-entry.
  if (!cart.checkoutInFlight.value) isProcessing.value = false;

  const activationReads = [];
  if (refresh?.settings) activationReads.push(terminal.loadSettings({ force: true }));
  if (refresh?.held) activationReads.push(fetchHeldOrderSummary());
  if (activationReads.length) await Promise.all(activationReads);

  // Mount owns the first held-order claim. A later KeepAlive activation can
  // recover a new handoff without racing the mount-time claim.
  let restoreOutcome = 'none';
  let restoreSource = null;
  if (isReactivation && auth.activeUser.value?.role !== 'call_center') {
    restoreOutcome = await checkAndRestoreHeldOrder(false);
    restoreSource = cart.consumeRestoreSource();
  }
  // Mount owns the first catalog snapshot too, in every context.
  if (isReactivation) {
    const plan = planActivationCartRefresh({
      catalog: refresh?.catalog,
      contextChanged,
      catalogIds: refresh?.catalogIds || [],
      stock: refresh?.stock,
      restoreOutcome,
      restoreSource,
    });
    if (plan.catalog) {
      // A dirty or recovering catalog is confirmed against the server token first;
      // a context switch alone (preferCache) paints its cache without asking. A
      // context change with no saved snapshot leaves an empty grid, so it always reads.
      const localFallback = restoreOutcome === 'local-held-order' || restoreSource === 'local';
      void (plan.catalog.preferCache || contextChanged
        ? refreshCatalogAndCart(plan.catalog)
        : refreshCatalogUnlessCurrent({ ...plan.catalog, repriceOnMatch: localFallback }));
    } else if (plan.catalogIds.length) {
      // Same cheap paths the active inventory_changed handler takes.
      void onInventoryChanged({ scope: 'catalog', productIds: plan.catalogIds }, {
        refreshCartPrices: plan.refreshCartPrices,
      });
    } else if (plan.stock) {
      stockRefresh.noteUnscoped();
    }
    if (plan.repriceCart) void refreshCartCatalogPrices({ refreshPrices: true });
  }
  if (refresh?.shift) void reconcileOpeningShiftReference();

  // Load the latest QR customer table draft if activeTable is set.
  if (auth.activeUser.value?.role !== 'call_center' && activeTable.value && activeTable.value.id) {
    loadActiveTableDraft(activeTable.value.id); // guarded against a mid-flight table switch
  }

  // Setup Socket Listeners on Activation
  try {
    const s = bindCatalogSocketListeners();
    s.off('settings_changed', onSettingsChanged);
    s.on('settings_changed', onSettingsChanged);
    if (auth.activeUser.value?.role !== 'call_center') {
      s.off('table_update', onTableUpdate);
      s.on('table_update', onTableUpdate);
      s.off('table_draft_changed', onTableDraftChanged);
      s.on('table_draft_changed', onTableDraftChanged);
      s.off('held_orders_changed', onHeldOrdersChanged);
      s.on('held_orders_changed', onHeldOrdersChanged);
    }
  } catch (socketErr) {
    console.error("Failed to initialize POS Socket connection:", socketErr);
  }

  // Initialize Hardware Listeners (only if not viewing a table order)
  if (terminal.setupBarcodeListener && !activeTable.value) {
    terminal.setupBarcodeListener(products.products, cart.addToCart, cancelQuickAmount);
  }

  window.addEventListener('socket_reconnected', handleSocketReconnected);
  window.addEventListener('focus', handleWindowFocus);
  // Restart idle tracker in case this is a fresh login (App.vue's onMounted ran before sessionStorage was populated)
  if (auth.activeUser.value?.id) startIdleTracker(auth.activeUser.value);
});

onDeactivated(() => {
  isActive.value = false;
  clearLeavingTable();
  products.cancelCatalogRecovery();
  cancelQuickAmount();
  stockRefresh.cancel();
  tableContextRequestId += 1;
  if (socket.value) {
    socket.value.off('inventory_changed', onInventoryChanged);
    socket.value.off('product_availability_changed', onProductAvailabilityChanged);
    socket.value.off('shifts_changed', onShiftLifecycleChanged);
    socket.value.off('settings_changed', onSettingsChanged);
    socket.value.off('table_update', onTableUpdate);
    socket.value.off('table_draft_changed', onTableDraftChanged);
    socket.value.off('held_orders_changed', onHeldOrdersChanged);
    socket.value.off('connect', onSocketConnect);
    socket.value.off('inventory_changed', onInactiveInventoryChanged);
    socket.value.on('inventory_changed', onInactiveInventoryChanged);
    socket.value.off('product_availability_changed', onInactiveAvailabilityChanged);
    socket.value.on('product_availability_changed', onInactiveAvailabilityChanged);
    socket.value.off('settings_changed', onInactiveSettingsChanged);
    socket.value.on('settings_changed', onInactiveSettingsChanged);
    socket.value.off('held_orders_changed', onInactiveHeldOrdersChanged);
    socket.value.on('held_orders_changed', onInactiveHeldOrdersChanged);
    socket.value.off('shifts_changed', onInactiveShiftsChanged);
    socket.value.on('shifts_changed', onInactiveShiftsChanged);
  }
  refreshTracker.deactivate(connectionGeneration.value);
  if (tableUpdateTimeout) {
    clearTimeout(tableUpdateTimeout);
    tableUpdateTimeout = null;
  }
  if (heldSummaryRefreshTimer) {
    clearTimeout(heldSummaryRefreshTimer);
    heldSummaryRefreshTimer = null;
  }
  if (terminal.teardownBarcodeListener) {
    terminal.teardownBarcodeListener();
  }
  window.removeEventListener('socket_reconnected', handleSocketReconnected);
  window.removeEventListener('focus', handleWindowFocus);
});

onUnmounted(() => {
  cancelHotDialogPreload();
  terminal.cancelSettingsRecovery();
  socket.value?.io.off('ping', terminal.retryFailedSettings);
  socket.value?.io.off('ping', retryFailedShiftCheck);
  socket.value?.io.off('ping', retryFailedReads);
  products.cancelCatalogRecovery();
  stockRefresh.cancel();
  tableContextRequestId += 1;
  if (socket.value) {
    socket.value.off('inventory_changed', onInventoryChanged);
    socket.value.off('product_availability_changed', onProductAvailabilityChanged);
    socket.value.off('shifts_changed', onShiftLifecycleChanged);
    socket.value.off('settings_changed', onSettingsChanged);
    socket.value.off('table_update', onTableUpdate);
    socket.value.off('table_draft_changed', onTableDraftChanged);
    socket.value.off('held_orders_changed', onHeldOrdersChanged);
    socket.value.off('connect', onSocketConnect);
    socket.value.off('inventory_changed', onInactiveInventoryChanged);
    socket.value.off('product_availability_changed', onInactiveAvailabilityChanged);
    socket.value.off('settings_changed', onInactiveSettingsChanged);
    socket.value.off('held_orders_changed', onInactiveHeldOrdersChanged);
    socket.value.off('shifts_changed', onInactiveShiftsChanged);
  }
  if (tableUpdateTimeout) {
    clearTimeout(tableUpdateTimeout);
    tableUpdateTimeout = null;
  }
  if (heldSummaryRefreshTimer) {
    clearTimeout(heldSummaryRefreshTimer);
    heldSummaryRefreshTimer = null;
  }
  if (terminal.teardownBarcodeListener) {
    terminal.teardownBarcodeListener();
  }
  document.removeEventListener('fullscreenchange', syncFullscreenState);
  window.removeEventListener('socket_reconnected', handleSocketReconnected);
  window.removeEventListener('focus', handleWindowFocus);
});
</script>

<style scoped>
button, input, select, textarea {
  touch-action: manipulation;
}
.pos-button:active {
  transform: scale(0.96);
}

.drawer-theme-indicator {
  display: flex;
  width: 2.25rem;
  height: 1.25rem;
  flex: 0 0 auto;
  align-items: center;
  justify-content: flex-start;
  padding: 2px;
  border: 1px solid var(--color-outline-variant);
  border-radius: 999px;
  background: var(--color-surface-container-highest);
}

.drawer-theme-indicator.is-active {
  justify-content: flex-end;
  border-color: var(--color-primary);
  background: var(--color-primary);
}

.drawer-theme-indicator > span {
  width: 0.875rem;
  height: 0.875rem;
  border-radius: 50%;
  background: var(--color-surface-container-lowest);
}

.logical-inline-start {
  inset-inline-start: 0;
  inset-inline-end: auto;
}

.logical-inline-end {
  inset-inline-end: 0;
  inset-inline-start: auto;
}

.pos-dropdown-panel {
  max-width: calc(100vw - 1.5rem);
}

.pos-user-menu {
  inset-block-start: 2.75rem;
  inset-inline-start: 0.5rem;
  width: min(14rem, calc(100vw - 1.5rem));
  transform-origin: top left;
}

html[dir="rtl"] .pos-user-menu {
  transform-origin: top right;
}

.pos-dropup-end {
  inset-inline-end: 0;
  inset-inline-start: auto;
}

.toast-enter-active {
  transition: opacity 150ms ease-out, transform 150ms ease-out;
}

.toast-leave-active {
  display: none;
}

.toast-enter-from {
  opacity: 0;
  transform: translateY(-10px) translateX(-50%);
}



/* Sidebar drawer: enter-only slide; it leaves at once because a dialog or
   route it opened is waiting behind it (DESIGN.md motion rule). */
.slide-sidebar-left-enter-active,
.slide-sidebar-right-enter-active {
  transition: transform 150ms ease-out;
}
.slide-sidebar-left-enter-from {
  transform: translate3d(-100%, 0, 0);
}
.slide-sidebar-right-enter-from {
  transform: translate3d(100%, 0, 0);
}
.slide-sidebar-left-leave-active,
.slide-sidebar-right-leave-active {
  display: none;
}

/* Custom performance-optimized sidebar backdrop */
.sidebar-backdrop {
  position: fixed;
  inset: 0;
  background-color: rgba(15, 23, 42, 0.4); /* Slate-900 with 40% opacity */
  z-index: 94;
}

/* Backdrop fade: enter-only */
.fade-enter-active {
  transition: opacity 150ms ease-out;
}
.fade-enter-from {
  opacity: 0;
}
.fade-leave-active {
  display: none;
}

@media (prefers-reduced-motion: reduce) {
  .fade-enter-active,
  .toast-enter-active,
  .slide-sidebar-left-enter-active,
  .slide-sidebar-right-enter-active {
    transition-duration: 0.01ms;
  }
}
</style>
