<template>
        <!-- Cart Sidebar Panel -->
        <div :class="['cart-panel fixed inset-y-0 right-0 z-50 w-full sm:w-[400px] lg:w-[340px] xl:w-[400px] bg-surface-container-lowest flex flex-col shadow-2xl transition-transform ease-out lg:relative lg:translate-x-0 lg:shadow-none border-l border-outline-variant/30', mobileCartOpen ? 'translate-x-0 duration-150' : 'translate-x-full duration-0']" style="transform: translate3d(0,0,0); backface-visibility: hidden; -webkit-backface-visibility: hidden;">
          <div v-if="!isCallCenter || mobileCartOpen" class="cart-navigation h-12 border-b border-outline-variant/30 flex items-center justify-end px-3 shrink-0 bg-surface-container-low relative">
            <div class="cart-nav-actions flex items-center gap-1.5 relative z-10">
              <template v-if="!isCallCenter">
              <button @click="openSplitModal" :disabled="cartItems.length === 0 || !canSplitActiveTable"
                class="cart-nav-action text-teal-700 font-bold text-[10px] px-2.5 py-1.5 rounded-lg bg-teal-50 border border-teal-200 hover:bg-teal-600 hover:text-white transition-all disabled:opacity-40 uppercase tracking-wider">{{ $t('Split') }}</button>
              <template v-if="activeTable">
                <button v-if="canTransferTable && !activeTable.parent_table_id" @click="$emit('table-action', 'transfer')"
                  class="cart-nav-action text-teal-700 font-bold text-[10px] px-2.5 py-1.5 rounded-lg bg-teal-50 border border-teal-200 hover:bg-teal-600 hover:text-white transition-all uppercase tracking-wider">{{ $t('Transfer') }}</button>
                <button v-if="canJoinTables && canJoinActiveSeating" @click="$emit('table-action', 'join')"
                  class="cart-nav-action text-teal-700 font-bold text-[10px] px-2.5 py-1.5 rounded-lg bg-teal-50 border border-teal-200 hover:bg-teal-600 hover:text-white transition-all uppercase tracking-wider">{{ $t('Join') }}</button>
                <button v-if="hasActiveSeatingGroup" @click="$emit('table-action', 'disjoin')"
                  class="cart-nav-action cart-nav-danger text-rose-700 font-bold text-[10px] px-2.5 py-1.5 rounded-lg bg-rose-50 border border-rose-200 hover:bg-rose-600 hover:text-white transition-all uppercase tracking-wider">{{ $t('Disjoin') }}</button>
              </template>
              <template v-if="!activeTable && canHoldOrder">
                <button @click="router.push('/order-notes')"
                  class="cart-nav-action relative text-on-surface-variant font-bold text-[10px] px-2.5 py-1.5 rounded-lg bg-surface border border-outline-variant/40 hover:bg-surface-container-low transition-all uppercase tracking-wider">
                  {{ $t('Held') }}
                  <span v-if="activeHeldCount > 0" class="held-count-badge" data-no-i18n>{{ activeHeldCount > 99 ? '99+' : activeHeldCount }}</span>
                </button>
              </template>
              <button @click="clearCart" :disabled="!canClearCart || isProcessing"
                :title="hasSavedTableItems && !canVoidActiveTable ? $t('You do not have permission to void saved items.') : ''"
                class="cart-nav-action cart-nav-danger text-rose-600 font-bold text-[10px] px-2.5 py-1.5 rounded-lg bg-rose-50 border border-rose-200 hover:bg-rose-600 hover:text-white transition-all uppercase tracking-wider disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5">
                <i v-if="hasSavedTableItems && !canVoidActiveTable" class="fa-solid fa-lock text-[8px]"></i>
                <span>{{ $t('Clear') }}</span>
              </button>
              </template>
              <button
                type="button"
                @click="mobileCartOpen = false"
                class="cart-nav-action cart-nav-close lg:hidden"
                :aria-label="$t('Close')"
              >
                <i class="fa-solid fa-xmark text-sm" aria-hidden="true"></i>
              </button>
            </div>
          </div>

          <div v-if="isCallCenter" class="call-center-cart-identity">
            <div class="call-center-cart-identity__customer">
              <strong data-no-i18n>{{ customerName || $t('Phone order') }}</strong>
              <small data-no-i18n>{{ customerPhone }}</small>
            </div>
            <div class="call-center-cart-identity__actions">
              <button type="button" @click="editCallCenterCustomer">{{ $t('Edit') }}</button>
              <button type="button" class="is-danger" @click="handleCallCenterAbort">
                {{ $t(restoredHeldOrder?.id ? 'Cancel edits' : 'Cancel Call') }}
              </button>
            </div>
          </div>

          <div v-if="activeTable?.is_split" class="mx-2 mt-2 rounded-lg border border-primary/30 bg-primary-fixed px-3 py-2 text-[10px] font-bold text-on-primary-fixed-variant" role="status">
            <i class="fa-solid fa-lock me-1" aria-hidden="true"></i>
            {{ $t('Payment view only. Use Edit on the Split Board to move items.') }}
          </div>

          <div v-if="activeTable && tableSaveError" class="mx-2 mt-2 flex items-start gap-2 rounded-lg border border-error/40 bg-error-container px-3 py-2 text-xs font-bold text-on-error-container" role="alert">
            <i class="fa-solid fa-triangle-exclamation mt-0.5" aria-hidden="true"></i>
            <span class="flex-1 text-start">{{ $t(tableSaveError) }}</span>
            <button type="button" class="shrink-0 px-1" :aria-label="$t('Dismiss')" @click="tableSaveError = ''">
              <i class="fa-solid fa-xmark" aria-hidden="true"></i>
            </button>
          </div>

          <!-- QR Customer Cart Integration Notification -->
          <div v-if="activeQrDraft && activeQrDraft.length > 0" class="m-2 p-3 bg-blue-50 border border-blue-200 rounded-xl flex flex-col gap-2 shadow-sm text-start shrink-0">
            <div class="flex items-center justify-between">
              <span class="text-[9px] font-black text-blue-800 uppercase tracking-widest flex items-center gap-1.5">
                <i class="fa-solid fa-mobile-screen-button text-[10px] animate-pulse"></i>
                {{ $t('QR Customer Cart') }} ({{ activeQrDraft.length }} {{ $t('items') }})
              </span>
              <button @click="$emit('review-qr')" class="text-[9px] font-black text-blue-600 hover:text-blue-800 uppercase tracking-widest underline">
                {{ $t('Review') }}
              </button>
            </div>
            <p class="text-[10px] text-blue-700 font-semibold leading-relaxed">
              {{ $t('Customers at this table have placed items in their digital cart.') }}
            </p>
            <div class="flex gap-1.5 mt-1">
              <button @click="$emit('import-qr')" :disabled="isImportingQrDraft" class="flex-1 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-black text-[9px] uppercase tracking-wider transition-colors shadow-sm disabled:opacity-50 disabled:cursor-not-allowed">
                {{ $t('Import All') }}
              </button>
              <button @click="$emit('dismiss-qr')" class="px-2 py-1.5 bg-white border border-blue-200 text-blue-700 hover:bg-blue-100 rounded-lg font-black text-[9px] uppercase tracking-wider transition-colors">
                {{ $t('Dismiss') }}
              </button>
            </div>
          </div>

          <div class="cart-items-scroll flex-1 overflow-y-auto premium-scroll bg-surface" @click="selectedCartIndex = null; numpadInput = ''">
            <table class="w-full text-start whitespace-nowrap">
              <thead class="cart-table-header bg-surface-container-lowest sticky top-0 z-10 shadow-sm border-b border-outline-variant/30">
                <tr class="text-xs uppercase text-on-surface-variant font-black tracking-wider">
                  <th class="py-1.5 px-2 text-start">{{ $t('Item') }}</th>
                  <th class="py-1.5 px-1 text-center w-12">{{ $t('Qty') }}</th>
                  <th class="py-1.5 px-1 text-end w-16">{{ $t('Price') }}</th>
                  <th class="py-1.5 px-2 text-end w-20">{{ $t('Total') }}</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-outline-variant/10 text-xs">
                <tr v-if="cartItems.length === 0">
                  <td colspan="4" class="p-10 text-center text-on-surface-variant font-bold text-xs uppercase tracking-widest">
                    {{ $t('Empty Order') }}
                  </td>
                </tr>
                <template v-for="group in cartRenderModel.groups" :key="'group-'+group.courseLevel">
                    <tr v-if="group.courseLevel !== null" class="bg-surface-container-high border-y border-outline-variant/30">
                      <td colspan="4" class="py-1 px-2">
                        <span class="font-black text-[9px] uppercase tracking-widest text-on-surface-variant">
                          {{ $t('Course') + ' ' + group.courseLevel }}
                        </span>
                      </td>
                    </tr>
                    <tr v-for="row in group.rows" :key="row.key"
                      @click.stop="selectCartRow(row)"
                      :class="[activeTable?.is_split ? 'cursor-default' : 'cursor-pointer', 'transition-[background-color]', selectedCartIndex === row.index ? 'cart-row--selected' : 'bg-surface-container-lowest hover:bg-surface-container-low']">
                      <td class="py-1.5 px-2 whitespace-normal">
                        <div :class="['cart-item-name font-bold text-on-surface', { 'font-arabic': isArabic(row.displayName) }]" data-no-i18n>{{ row.displayName }}</div>
                        <div v-if="row.item.note && row.item.note !== 'Auto-Gratuity'"
                          class="text-[9px] text-tertiary font-bold mt-0.5 bg-tertiary-fixed inline-flex flex-col gap-0.5 px-1.5 py-0.5 rounded border border-tertiary-fixed-dim text-left" data-no-i18n>
                          <div v-for="(line, lineIndex) in row.noteLines" :key="lineIndex" class="flex items-center gap-1">
                            <span class="text-tertiary/60 select-none">•</span>
                            <span>{{ line }}</span>
                          </div>
                        </div>
                        <div v-if="row.item.discountValue > 0" class="text-[9px] font-bold text-error mt-0.5 uppercase tracking-wider">
                          {{ row.item.discountType === 'percent' ? row.item.discountValue + '%' : row.item.discountValue + ' JD' }} {{ $t('Off') }}
                          <template v-if="row.presentation">
                            (-{{ row.presentation.lineDiscountAmount.toFixed(2) }} JD)
                          </template>
                        </div>
                        <!-- Bundle sub-items: indented below parent line; descriptive only -->
                        <div v-if="row.item.is_bundle && row.item.bundleItems && row.item.bundleItems.length" class="mt-1 ps-3 space-y-0.5">
                          <div v-for="sub in row.item.bundleItems" :key="sub.product_id"
                               class="flex items-center justify-between text-[11px] text-on-surface-variant"
                               :class="{ 'line-through text-on-surface-variant/60': sub.removed }">
                            <span class="flex-1 text-start leading-snug" data-no-i18n>
                              &bull; {{ sub.name }} &times; {{ (Number(sub.qty) || 1) * Number(row.item.qty) }}
                              <span v-if="sub.note" class="italic"> — {{ sub.note }}</span>
                            </span>
                          </div>
                        </div>
                      </td>
                      <td class="py-1.5 px-1 text-center align-middle">
                        <span class="font-black text-on-surface bg-surface border border-outline-variant/30 px-1.5 py-0.5 rounded shadow-sm text-xs">{{ row.item.qty }}</span>
                      </td>
                      <td class="py-1.5 px-1 text-end font-bold text-on-surface-variant align-middle text-xs">
                        {{ row.netAmount.toFixed(2) }}
                      </td>
                      <td class="py-1.5 px-2 text-end font-black text-on-surface align-middle text-xs">
                        {{ row.grossTotal.toFixed(2) }}
                      </td>
                    </tr>
                </template>
                <tr v-if="showAutomaticServiceChargeRow" class="service-row border-t-2 border-teal-200 bg-teal-50/70">
                  <td class="py-2 px-2 whitespace-normal">
                    <div class="flex items-start justify-between gap-2">
                      <div class="flex items-start gap-2 min-w-0">
                        <span class="service-row-icon mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-teal-100 text-teal-700">
                          <i class="fa-solid fa-bell-concierge text-[9px]" aria-hidden="true"></i>
                        </span>
                        <div class="min-w-0">
                          <div :class="['service-row-title font-black text-teal-950 text-[11px] leading-tight', { 'font-arabic': isArabic(serviceChargeDisplayName(serviceChargeItem, t)) }]" data-no-i18n>
                            {{ serviceChargeDisplayName(serviceChargeItem, t) }}
                          </div>
                          <div class="service-row-meta text-[9px] font-semibold text-teal-700 mt-0.5">{{ $t('Added automatically for this table') }}</div>
                        </div>
                      </div>
                      <button v-if="canRemoveAutoServiceCharge" type="button" @click.stop="removeAutoServiceCharge"
                        class="service-row-remove shrink-0 rounded-md border border-rose-200 bg-white px-2 py-1 text-[9px] font-black text-rose-600 transition-colors hover:bg-rose-600 hover:text-white">
                        {{ $t('Remove') }}
                      </button>
                    </div>
                  </td>
                  <td class="py-2 px-1 text-center align-middle">
                    <span class="service-row-value font-black text-teal-950 text-[11px]">1</span>
                  </td>
                  <td class="service-row-value py-2 px-1 text-end font-bold text-teal-800 align-middle text-[10px]">
                    {{ serviceChargeGrossTotal.toFixed(2) }}
                  </td>
                  <td class="service-row-value py-2 px-2 text-end font-black text-teal-950 align-middle text-[11px]">
                    {{ serviceChargeGrossTotal.toFixed(2) }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div class="cart-item-actions grid grid-cols-3 p-1 border-t border-outline-variant/30 bg-surface-container-lowest shrink-0 gap-1.5 shadow-sm relative z-20">
            <button @click="openNoteModal('item')" :disabled="selectedCartIndex === null || activeTable?.is_split"
              class="cart-item-action py-1.5 text-[10px] font-bold text-on-surface-variant bg-surface-container-lowest rounded-lg border border-outline-variant/40 hover:bg-surface-container-low disabled:opacity-40 uppercase tracking-wider">{{ $t('Note') }}</button>
            <button v-if="!isCallCenter" @click="$emit('open-more-actions')" :disabled="activeTable?.is_split"
              class="cart-item-action py-1.5 text-[10px] font-black text-teal-700 bg-teal-50 rounded-lg border border-teal-200 hover:bg-teal-100 uppercase tracking-wider">{{ $t('More') }}</button>
            <button @click="removeSelectedCartItem" :disabled="!canRemoveSelectedCartItem || isProcessing || activeTable?.is_split"
              :title="selectedCartItemIsSaved && !canVoidActiveTable ? $t('You do not have permission to void saved items.') : ''"
              class="cart-item-action py-1.5 text-[10px] font-bold text-rose-600 bg-rose-50 rounded-lg border border-rose-200 hover:bg-rose-600 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed uppercase tracking-wider flex items-center justify-center gap-1.5">
              <i v-if="selectedCartItemIsSaved && !canVoidActiveTable" class="fa-solid fa-lock text-[8px]"></i>
              <span>{{ $t('Remove') }}</span>
            </button>
          </div>

          <div class="cart-control-panel p-2 bg-surface-container-lowest border-t border-outline-variant/30 shrink-0 z-10 shadow-[0_-3px_10px_rgba(0,0,0,0.03)] flex flex-col gap-2">
            <div v-if="orderNote"
              class="p-1.5 bg-secondary-container rounded text-[10px] text-on-secondary-container flex justify-between items-start font-bold border border-secondary-fixed-dim">
              <span class="truncate pe-2">{{ $t('Note') }}: <span data-no-i18n>{{ orderNote }}</span></span>
              <button @click="orderNote = ''" class="text-on-secondary-container hover:text-error font-black px-1">X</button>
            </div>

            <div class="numpad-console">
              <div class="numpad-readout" aria-live="polite">
                <span class="min-w-0 flex-1 truncate text-[9px] font-black text-on-surface" data-no-i18n>{{ numpadTargetLabel }}</span>
                <span class="text-[9px] font-bold text-on-surface-variant">· {{ quickNumpadMode ? $t(quickTargetAmount != null ? 'Qty' : 'Amount') : numpadModeLabel }}</span>
                <output class="min-w-8 text-end font-mono text-sm font-black leading-none text-primary" data-no-i18n>{{ numpadDisplayValue }}</output>
              </div>

              <div v-if="quantityPresetsEnabled && (quickNumpadMode || numpadMode === 'qty')" dir="ltr" class="numpad-quantity-presets grid grid-cols-4 gap-px">
                <button v-for="preset in quantityPresets" :key="preset" type="button"
                  @click="applyQuantityPreset(preset)" :disabled="activeTable?.is_split"
                  :aria-label="`${$t('Qty')} ${preset}`"
                  class="btn-3d min-h-8 border border-outline-variant/40 bg-surface-container-lowest font-mono text-xs font-black text-on-surface hover:bg-surface-container-low disabled:opacity-50"
                  style="--shadow-color: #6f7d8e;">{{ preset }}</button>
              </div>

              <!-- Numpad (calculator order: 7-8-9 top, 0 bottom; LTR so Arabic matches) -->
              <fieldset dir="ltr" :disabled="activeTable?.is_split" class="numpad grid grid-cols-4 gap-1.5 p-1 bg-surface-container rounded-xl border border-outline-variant/20 disabled:opacity-50">
                <button @click="appendNumpad('7')"
                class="btn-3d bg-surface-container-lowest border border-outline-variant/40 hover:bg-surface-container-low rounded-xl font-bold text-on-surface py-2.5 text-base transition-all flex items-center justify-center" style="--shadow-color: #6f7d8e;">7</button>
              <button @click="appendNumpad('8')"
                class="btn-3d bg-surface-container-lowest border border-outline-variant/40 hover:bg-surface-container-low rounded-xl font-bold text-on-surface py-2.5 text-base transition-all flex items-center justify-center" style="--shadow-color: #6f7d8e;">8</button>
              <button @click="appendNumpad('9')"
                class="btn-3d bg-surface-container-lowest border border-outline-variant/40 hover:bg-surface-container-low rounded-xl font-bold text-on-surface py-2.5 text-base transition-all flex items-center justify-center" style="--shadow-color: #6f7d8e;">9</button>
              <button v-if="quickNumpadMode" type="button" @click="armQuickAmount"
                :disabled="selectedCartIndex !== null || !(Number(numpadInput) > 0)"
                :aria-pressed="quickTargetAmount != null"
                :class="['btn-3d row-span-3 rounded-xl border text-2xl font-black transition-all', quickTargetAmount != null ? 'bg-teal-600 text-white border-teal-700 shadow-md' : 'bg-surface-container-lowest border-outline-variant/40 text-on-surface hover:bg-surface-container-low']"
                :style="{ '--shadow-color': quickTargetAmount != null ? '#2b4b71' : '#6f7d8e' }">×</button>
              <button v-else @click="setNumpadMode('qty')"
                :class="['btn-3d rounded-xl font-bold text-[10px] py-2.5 uppercase tracking-widest transition-all border', numpadMode === 'qty' ? 'bg-teal-600 text-white border-teal-700 shadow-md' : 'bg-surface-container-lowest border-outline-variant/40 text-on-surface-variant hover:bg-surface-container-low']" :style="{ '--shadow-color': numpadMode === 'qty' ? '#2b4b71' : '#6f7d8e' }">{{ $t('Qty') }}</button>
              <button @click="appendNumpad('4')"
                class="btn-3d bg-surface-container-lowest border border-outline-variant/40 hover:bg-surface-container-low rounded-xl font-bold text-on-surface py-2.5 text-base transition-all flex items-center justify-center" style="--shadow-color: #6f7d8e;">4</button>
              <button @click="appendNumpad('5')"
                class="btn-3d bg-surface-container-lowest border border-outline-variant/40 hover:bg-surface-container-low rounded-xl font-bold text-on-surface py-2.5 text-base transition-all flex items-center justify-center" style="--shadow-color: #6f7d8e;">5</button>
              <button @click="appendNumpad('6')"
                class="btn-3d bg-surface-container-lowest border border-outline-variant/40 hover:bg-surface-container-low rounded-xl font-bold text-on-surface py-2.5 text-base transition-all flex items-center justify-center" style="--shadow-color: #6f7d8e;">6</button>
              <button v-if="!quickNumpadMode" @click="setNumpadMode('discount')" :disabled="isCallCenter || !canApplyDiscount"
                :class="['btn-3d rounded-xl font-bold text-[10px] py-2.5 uppercase tracking-widest relative transition-all border', isCallCenter || !canApplyDiscount ? 'bg-surface-container-lowest text-on-surface-variant opacity-60' : numpadMode === 'discount' ? 'bg-teal-600 text-white border-teal-700 shadow-md' : 'bg-surface-container-lowest border-outline-variant/40 text-on-surface-variant hover:bg-surface-container-low']" :style="{ '--shadow-color': isCallCenter || !canApplyDiscount ? 'transparent' : (numpadMode === 'discount' ? '#2b4b71' : '#6f7d8e') }">
                <i v-if="isCallCenter || !canApplyDiscount" class="fa-solid fa-lock absolute top-1 end-1 text-[8px] text-on-surface-variant"></i>%
                {{ $t('Disc') }}
              </button>
              <button @click="appendNumpad('1')"
                class="btn-3d bg-surface-container-lowest border border-outline-variant/40 hover:bg-surface-container-low rounded-xl font-bold text-on-surface py-2.5 text-base transition-all flex items-center justify-center" style="--shadow-color: #6f7d8e;">1</button>
              <button @click="appendNumpad('2')"
                class="btn-3d bg-surface-container-lowest border border-outline-variant/40 hover:bg-surface-container-low rounded-xl font-bold text-on-surface py-2.5 text-base transition-all flex items-center justify-center" style="--shadow-color: #6f7d8e;">2</button>
              <button @click="appendNumpad('3')"
                class="btn-3d bg-surface-container-lowest border border-outline-variant/40 hover:bg-surface-container-low rounded-xl font-bold text-on-surface py-2.5 text-base transition-all flex items-center justify-center" style="--shadow-color: #6f7d8e;">3</button>
              <button v-if="!quickNumpadMode" @click="setNumpadMode('price')" :disabled="isCallCenter || !canEnterPrice"
                :class="['btn-3d rounded-xl font-bold text-[10px] py-2.5 uppercase tracking-widest relative transition-all border', isCallCenter || !canEnterPrice ? 'bg-surface-container-lowest text-on-surface-variant opacity-60' : numpadMode === 'price' ? 'bg-teal-600 text-white border-teal-700 shadow-md' : 'bg-surface-container-lowest border-outline-variant/40 text-on-surface-variant hover:bg-surface-container-low']" :style="{ '--shadow-color': isCallCenter || !canEnterPrice ? 'transparent' : (numpadMode === 'price' ? '#2b4b71' : '#6f7d8e') }">
                <i v-if="isCallCenter || !canEnterPrice" class="fa-solid fa-lock absolute top-1 end-1 text-[8px] text-on-surface-variant"></i>{{ $t('Price') }}
              </button>
              <button @click="clearNumpad"
                class="btn-3d bg-surface-container-lowest border border-outline-variant/40 hover:bg-surface-container-low rounded-xl font-black text-on-surface py-2.5 text-xs uppercase transition-all flex items-center justify-center" style="--shadow-color: #6f7d8e;">C</button>
              <button @click="appendNumpad('0')"
                class="btn-3d bg-surface-container-lowest border border-outline-variant/40 hover:bg-surface-container-low rounded-xl font-bold text-on-surface py-2.5 text-base transition-all flex items-center justify-center" style="--shadow-color: #6f7d8e;">0</button>
              <button @click="appendNumpad('.')"
                class="btn-3d bg-surface-container-lowest border border-outline-variant/40 hover:bg-surface-container-low rounded-xl font-bold text-on-surface py-2.5 text-base transition-all flex items-center justify-center" style="--shadow-color: #6f7d8e;">.</button>
                <button @click="backspaceNumpad"
                  class="numpad-delete-key btn-3d border font-black py-2.5 text-[10px] uppercase transition-all flex items-center justify-center" style="--shadow-color: #6f7d8e;">{{ $t('DEL') }}</button>
              </fieldset>
            </div>

            <!-- Totals & Actions -->
            <div class="cart-checkout-strip flex items-stretch">
              <div class="cart-summary flex-1 flex flex-col justify-between bg-surface-container-low p-2.5 border border-outline-variant/30 font-sans">
                <div class="space-y-1">
                  <div class="flex justify-between text-xs font-bold text-on-surface-variant">
                    <span>{{ $t('Subtotal') }}</span>
                    <span class="text-on-surface font-mono font-semibold">
                      {{ (cartReceiptPresentation?.summary?.subtotal ?? cartSubtotal).toFixed(2) }}
                    </span>
                  </div>
                  <div v-if="orderDiscount.value > 0" class="flex justify-between text-xs font-black text-error">
                    <span>{{ $t('Disc') }} ({{ orderDiscount.type === 'percent' ? orderDiscount.value + '%' : $t('Fix') }})</span>
                    <span class="font-mono font-black">
                      -{{ (cartReceiptPresentation?.summary?.orderDiscountAmount ?? cartOrderDiscountAmount).toFixed(2) }}
                    </span>
                  </div>
                  <div class="flex justify-between text-xs font-bold text-on-surface-variant">
                    <span>{{ $t('Tax') }}</span>
                    <span v-if="isTaxExempt" class="text-on-surface-variant text-[10px] italic font-medium">
                      ({{ $t('Tax Exempt') }})
                    </span>
                    <span v-else-if="cartReceiptPresentation?.summary?.taxLabel" class="text-on-surface-variant text-[10px] italic font-medium">
                      {{ $t(cartReceiptPresentation.summary.taxLabel) }}
                    </span>
                    <span v-else class="text-on-surface font-mono font-semibold">
                      {{ (cartReceiptPresentation?.summary?.taxAmount ?? cartTax).toFixed(2) }}
                    </span>
                  </div>
                  <!-- Rounding row (only if non-zero) -->
                  <div v-if="cartReceiptPresentation?.summary?.roundingAdjustment && Math.abs(cartReceiptPresentation.summary.roundingAdjustment) > 0" class="flex justify-between text-xs font-bold text-on-surface-variant">
                    <span>{{ $t('Rounding') }}</span>
                    <span class="text-on-surface font-mono font-semibold">
                      {{ cartReceiptPresentation.summary.roundingAdjustment.toFixed(2) }}
                    </span>
                  </div>
                </div>
                <div class="flex justify-between items-end pt-1.5 mt-1.5 border-t border-outline-variant/20">
                  <span class="text-on-surface font-black text-xs uppercase tracking-widest">{{ $t('Total') }}</span>
                  <span class="text-on-surface font-black text-xl leading-none tracking-tighter font-mono">
                    {{ (cartReceiptPresentation?.summary?.total ?? cartTotal).toFixed(2) }} JD
                  </span>
                </div>
              </div>

              <div class="cart-final-actions flex flex-col w-[130px] sm:w-[150px] justify-end">
                  <button v-if="showBaselineConfirmButton" @click="handleBaselineConfirm"
                    :disabled="isProcessing || isHolding"
                    class="cart-final-action btn-3d w-full min-h-[3.25rem] py-3 bg-amber-600 text-white font-black text-[10px] hover:bg-amber-700 uppercase tracking-widest transition-all disabled:opacity-50"
                    style="--shadow-color: #6b4e16;">
                    <i class="fa-solid fa-triangle-exclamation me-1" aria-hidden="true"></i>
                    {{ $t('Confirm kitchen baseline') }}
                  </button>
                  <button v-if="showFollowUpButton" @click="handleFollowUp"
                    :disabled="cartItems.length === 0 || isProcessing || isHolding"
                    class="cart-final-action btn-3d w-full min-h-[3.25rem] py-3 bg-secondary text-on-secondary font-black text-[11px] hover:bg-secondary/90 uppercase tracking-widest transition-all disabled:opacity-50"
                    style="--shadow-color: #334155;">
                    <i v-if="isHolding" class="fa-solid fa-circle-notch fa-spin me-1"></i>
                    {{ $t('Send FOLLOW UP') }}
                  </button>
                  <button v-if="activeTable && can('tables.access') && (activeUser?.role !== 'cashier' || can('tables.save') || can('waiter.edit_locked'))" @click="handleUpdateTableOrder"
                    :disabled="cartItems.length === 0 || isProcessing || !canUpdateTable"
                    :title="!canUpdateTable && activeTable.current_order_id ? $t('Editing this order requires Edit saved orders permission.') : ''"
                    :class="showPayButton ? 'py-3' : 'flex-1 min-h-[3.25rem] py-3.5'"
                    class="cart-final-action btn-3d w-full bg-gray-800 text-white font-black text-[11px] hover:bg-gray-900 uppercase tracking-widest flex items-center justify-center gap-1 transition-all"
                    style="--shadow-color: #111827;">
                    <i v-if="isProcessing" class="fa-solid fa-circle-notch fa-spin"></i>
                    <span>{{ !canUpdateTable ? $t('No Update Access') : (isProcessing ? '...' : $t('Save Table')) }}</span>
                  </button>
                  <p v-if="activeTable?.current_order_id && !canUpdateTable && can('tables.save')" class="text-xs leading-snug text-muted-foreground py-2">
                    {{ $t('Editing this order requires Edit saved orders permission.') }}
                  </p>

                  <button v-if="showPayButton" @click="openCheckoutModal"
                    :disabled="cartItems.length === 0 || isUnsavedTableOrder || (!isCallCenter && !activeShift && !isAdminUser)"
                    :title="isUnsavedTableOrder ? $t('Save the order to the table before cashing out.') : ''"
                    class="cart-final-action btn-3d w-full flex-1 min-h-[3.25rem] py-3.5 bg-primary text-on-primary font-black text-base hover:bg-primary/90 uppercase tracking-widest transition-all disabled:opacity-50"
                    style="--shadow-color: #2b4b71;">
                    {{ $t(isCallCenter ? 'Send Order' : 'Pay') }}
                  </button>
              </div>
            </div>
          </div>
        </div>
</template>

<script setup>
import { computed, watch } from 'vue';
import { useRouter } from 'vue-router';
import { t } from '@/shared/i18n.js';
import { useAuth } from '@/pos/useAuth.js';
import { useCart } from '@/pos/useCart.js';
import { usePermissions } from '@/pos/usePermissions.js';
import { useTables } from '@/pos/useTables.js';
import { useTerminal } from '@/pos/useTerminal.js';
import { isArabic } from '@/utils/orderNotesFormat.js';
import { serviceChargeDisplayName } from '@/utils/serviceChargeDisplay.js';
import { buildCartRenderModel } from './cartRenderModel.js';

defineProps({
  isImportingQrDraft: { type: Boolean, default: false },
  activeHeldCount: { type: Number, default: 0 },
});
defineEmits(['table-action', 'review-qr', 'import-qr', 'dismiss-qr', 'open-more-actions']);

const router = useRouter();
const auth = useAuth();
const cart = useCart();
const tables = useTables();
const { quickNumpadMode, quantityPresetsEnabled } = useTerminal();
const { can } = usePermissions();

const { activeUser, activeShift } = auth;
const {
  cart: cartItems, selectedCartIndex, orderNote, orderDiscount, cartReceiptPresentation,
  isProcessing, isHolding, getItemTotalGross, removeSelectedCartItem, clearCart, openNoteModal,
  openCheckoutModal, removeAutoServiceCharge, appendNumpad, setNumpadMode,
  clearNumpad, backspaceNumpad, numpadInput, numpadMode, cartSubtotal,
  quickTargetAmount, armQuickAmount, cancelQuickAmount, applyQuantityPreset,
  cartOrderDiscountAmount, cartTax, cartTotal, mobileCartOpen, canRemoveAutoServiceCharge,
  isTaxExempt,
  autoApplyServiceCharge, canCheckout, canCheckoutTable, canApplyDiscount,
  canVoidActiveTable, hasSavedTableItems, canRemoveSelectedCartItem, canClearCart,
  restoredHeldReference, restoredHeldOrder, sendHeldOrderFollowUp, confirmHeldKitchenBaseline,
  customerPhone, customerName, showCheckoutModal, showCustomerDrawer,
  isCallCenter, startNewOrder, cancelCallCenterEdits,
} = cart;
const {
  activeTable, activeQrDraft, restaurantTables, openSplitModal, canUpdateTable,
  updateActiveTableOrder, canTransferTable, canJoinTables, canSplitActiveTable,
  loadActiveTableOrder, clearActiveTableSession, tableSaveError,
} = tables;

const serviceChargeItem = computed(() => cartItems.value.find(item => item.note === 'Auto-Gratuity') || null);
const serviceChargeGrossTotal = computed(() => serviceChargeItem.value ? getItemTotalGross(serviceChargeItem.value) : 0);
const activeSeatingChildren = computed(() => activeTable.value?.id
  ? restaurantTables.value.filter(table => Number(table.seating_parent_id) === Number(activeTable.value.id)) : []);
const hasActiveSeatingGroup = computed(() => !activeTable.value?.is_split && (activeTable.value?.seating_parent_id || activeSeatingChildren.value.length > 0));
const canJoinActiveSeating = computed(() => !activeTable.value?.is_split && !activeTable.value?.seating_parent_id
  && activeTable.value?.status !== 'printed' && !activeSeatingChildren.value.some(table => table.status === 'printed'));
const showAutomaticServiceChargeRow = computed(() => Boolean(
  serviceChargeItem.value && activeTable.value && autoApplyServiceCharge.value
));
const cartRenderModel = computed(() => buildCartRenderModel({
  cartItems: cartItems.value,
  presentationRows: cartReceiptPresentation.value?.rows,
  hideAutomaticServiceCharge: showAutomaticServiceChargeRow.value,
  getGrossTotal: getItemTotalGross,
  getDisplayName: item => serviceChargeDisplayName(item, t),
}));
const selectCartRow = (row) => {
  const currentIndex = cartItems.value[row.index] === row.item
    ? row.index
    : cartItems.value.indexOf(row.item);
  if (currentIndex < 0) return;
  cancelQuickAmount();
  selectedCartIndex.value = selectedCartIndex.value === currentIndex ? null : currentIndex;
  numpadInput.value = '';
};
const selectedCartItemIsSaved = computed(() => {
  if (selectedCartIndex.value === null) return false;
  return Number(cartItems.value[selectedCartIndex.value]?.originalQty) > 0;
});
const selectedCartItem = computed(() => (
  selectedCartIndex.value === null ? null : cartItems.value[selectedCartIndex.value] || null
));
const quantityPresets = Object.freeze(['0.125', '0.25', '0.5', '0.75']);
const numpadModeLabel = computed(() => t({ qty: 'Qty', discount: 'Disc', price: 'Price' }[numpadMode.value] || 'Qty'));
const numpadTargetLabel = computed(() => (
  selectedCartItem.value
    ? serviceChargeDisplayName(selectedCartItem.value, t)
    : t(quickNumpadMode.value || numpadMode.value === 'qty' ? 'Next item' : 'Select an item')
));
const numpadDisplayValue = computed(() => {
  if (numpadInput.value !== '') return numpadInput.value;
  const item = selectedCartItem.value;
  if (quickNumpadMode.value && quickTargetAmount.value == null) {
    return item ? Number(getItemTotalGross(item) || 0).toFixed(2) : '—';
  }
  if (!item) return numpadMode.value === 'qty' ? '1' : '—';
  if (numpadMode.value === 'price') return Number(getItemTotalGross(item) || 0).toFixed(2);
  if (numpadMode.value === 'discount') return Number(item.discountValue || 0).toFixed(2);
  return String(item.qty ?? 1);
});
const selectedCartItemPriceLocked = computed(() => Number(selectedCartItem.value?.price_override_locked) === 1);
const canEnterPrice = computed(() => Boolean(
  can('pos.price_override') && selectedCartItem.value && !selectedCartItemPriceLocked.value
));
watch(selectedCartItemPriceLocked, (locked) => {
  if (locked && numpadMode.value === 'price') setNumpadMode('qty');
});
watch(quickNumpadMode, () => {
  cancelQuickAmount();
  setNumpadMode('qty');
}, { immediate: true });
const canHoldOrder = computed(() => can('pos.hold_orders'));
const isAdminUser = computed(() => ['admin', 'programmer'].includes(activeUser.value?.role));
const isHeldBaselineUnknown = computed(() => Boolean(
  !activeTable.value && restoredHeldOrder.value?.id && restoredHeldOrder.value?.baselineUnknown === true
));
const showPayButton = computed(() => (
  isCallCenter.value || (!isHeldBaselineUnknown.value && (
    canCheckout.value || canCheckoutTable.value || (canHoldOrder.value && !activeTable.value)
  ))
));
const showFollowUpButton = computed(() => Boolean(
  !isCallCenter.value && !isHeldBaselineUnknown.value && !activeTable.value && restoredHeldOrder.value?.id && restoredHeldOrder.value?.kitchenFired === true
));
const showBaselineConfirmButton = computed(() => Boolean(
  !isCallCenter.value && isHeldBaselineUnknown.value && restoredHeldOrder.value?.claimToken && restoredHeldOrder.value?.version
));
const isUnsavedTableOrder = computed(() => (
  Boolean(activeTable.value && !activeTable.value.current_order_id && !activeTable.value.is_split)
));
const handleUpdateTableOrder = async () => {
  const leaving = activeUser.value?.role === 'waiter';
  const success = await updateActiveTableOrder({ keepProcessingOnSuccess: leaving, leaving });
  if (!success || !leaving) return;
  // A leaving save skips the reload, so saved lines lack order_item_id. End the
  // session once on the floor (re-opening reloads it); if navigation is blocked,
  // reload here so a later void, split or save has the saved ids.
  const failure = await router.push('/tables');
  if (failure) void loadActiveTableOrder(activeTable.value, { preserveDraft: true, keepQrDraft: true }).catch(() => {});
  else clearActiveTableSession({ clearCart: true });
};
const handleFollowUp = async () => {
  await sendHeldOrderFollowUp();
};
const editCallCenterCustomer = () => {
  showCustomerDrawer.value = true;
  showCheckoutModal.value = true;
};
const handleCallCenterAbort = async () => {
  if (restoredHeldOrder.value?.id) {
    await cancelCallCenterEdits();
    return;
  }
  startNewOrder();
};
const handleBaselineConfirm = async () => {
  const confirmed = await window.showPosConfirm?.(
    t('I verified that the current items were already sent to the kitchen.'),
    t('Confirm kitchen baseline'),
  );
  if (!confirmed) return;
  await confirmHeldKitchenBaseline();
};
</script>

