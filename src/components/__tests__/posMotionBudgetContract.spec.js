import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

// DESIGN.md motion rule: enter-only fades <=150ms desktop / <=200ms mobile,
// ease-out, no overshoot, outgoing content removed at once, reduced-motion honoured.
const read = (rel) => fs.readFileSync(path.resolve(__dirname, rel), 'utf8').replace(/\r\n/g, '\n');
const OVERSHOOT = /cubic-bezier\([^)]*,\s*1\.[0-9]+[^)]*\)/;
const durationsMs = (css) => [...css.matchAll(/(\d*\.?\d+)(ms|s)\b/g)]
  .map(([, n, unit]) => (unit === 's' ? Number(n) * 1000 : Number(n)));

describe('POS motion budget contract', () => {
  const posCss = read('../../pos.css');
  const app = read('../../App.vue');
  const terminal = read('../PosTerminal.vue');
  const floor = read('../TableFloorPlan.vue');
  const splits = read('../TableSplits.vue');
  const login = read('../Login.vue');
  const cart = read('../pos/PosCartWorkspace.vue');
  const catalog = read('../pos/PosCatalogWorkspace.vue');

  const block = (src, start, end) => src.slice(src.indexOf(start), src.indexOf(end, src.indexOf(start)));

  it('shared pos-modal enters within budget and leaves at once', () => {
    const css = block(posCss, '.pos-modal-enter-active', '/* Customer panel');
    expect(css).toContain('.pos-modal-leave-active { display: none; }');
    expect(Math.max(...durationsMs(css.split('@media')[0]))).toBeLessThanOrEqual(150);
    expect(css).toMatch(/prefers-reduced-motion/);
    const keypad = block(posCss, '.checkout-phone-keypad-enter-active', '@media (min-width: 701px)');
    expect(keypad).toMatch(/\.checkout-phone-keypad-leave-active \{\s*display: none;/);
    expect(Math.max(...durationsMs(keypad))).toBeLessThanOrEqual(150);
  });

  // Category and order-type highlights switching on the tap frame is a rendered
  // behaviour: scripts/reviews/pos-selection-highlight.cjs measures it per frame.
  it('Load More does not scale', () => {
    const loadMore = catalog.slice(catalog.lastIndexOf('class=', catalog.indexOf("$t('Load More')")));
    expect(loadMore.split('>')[0]).not.toMatch(/hover:scale|duration-200/);
  });

  it('App toast and global dialogs: no bounce, no overshoot, reduced-motion covered', () => {
    expect(app).not.toContain('animate-bounce"');
    expect(app).not.toMatch(OVERSHOOT);
    expect(app).not.toMatch(/duration-300/);
    expect(app).toContain('.app-toast-leave-active { display: none; }');
    expect(app).toMatch(/prefers-reduced-motion: reduce\) \{\s*\.animate-fade-in,\s*\.animate-scale-in/);
    expect(splits).not.toMatch(OVERSHOOT);
    expect(login).not.toMatch(OVERSHOOT);
    expect(login).toMatch(/prefers-reduced-motion[^}]*dot-animate/);
  });

  it('navigation drawer enters in 150ms, leaves at once and sits below dialogs it opens', () => {
    expect(terminal).toMatch(/\.slide-sidebar-left-leave-active,\s*\.slide-sidebar-right-leave-active \{\s*display: none;/);
    expect(terminal).toMatch(/\.fade-leave-active \{\s*display: none;/);
    expect(terminal).not.toMatch(/0\.35s/);
    expect(terminal).toContain('z-[95] flex flex-col');
    expect(terminal).toMatch(/\.sidebar-backdrop \{[^}]*z-index: 94;/);
  });

  it('floor modal-fade is enter-only and honours reduced motion', () => {
    expect(floor).toMatch(/\.modal-fade-leave-active \{\s*display: none;/);
    expect(floor).toMatch(/\.modal-fade-enter-active \{\s*transition: opacity 150ms ease-out;/);
    expect(block(floor, '@media (prefers-reduced-motion: reduce)', '\n}\n')).toContain('.modal-fade-enter-active');
  });

  it('mobile cart drawer opens in 150ms and closes at once', () => {
    const root = cart.split('\n')[2];
    expect(root).not.toContain('duration-300');
    expect(root).toContain("'translate-x-0 duration-150' : 'translate-x-full duration-0'");
  });
});
