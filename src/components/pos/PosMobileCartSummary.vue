<template>
  <div v-if="!mobileCartOpen" class="lg:hidden absolute bottom-4 left-4 right-4 z-30">
    <button @click="mobileCartOpen = true"
      class="w-full bg-primary text-on-primary rounded-xl p-4 shadow-xl flex justify-between items-center font-bold transition-all duration-200 ease-out hover:scale-[1.02] active:scale-[0.98]">
      <div class="flex items-center gap-3">
        <div class="bg-white text-teal-700 w-7 h-7 rounded flex items-center justify-center text-sm font-black shadow-sm" data-no-i18n>
          {{ cartItems.length }}
        </div>
        <span class="text-sm tracking-widest uppercase font-black">View Order</span>
      </div>
      <div class="flex items-center gap-2">
        <span class="font-black text-xl" data-no-i18n>{{ cartTotal.toFixed(2) }} JD</span>
        <i class="fa-solid fa-chevron-up text-white/70 text-sm"></i>
      </div>
    </button>
  </div>
</template>

<script setup>
import { useCart } from '@/pos/useCart.js';

const { cart: cartItems, cartTotal, mobileCartOpen } = useCart();
</script>
