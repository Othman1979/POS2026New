import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('Table floor approved design contract', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../TableFloorPlan.vue'), 'utf8').replace(/\r\n/g, '\n');
  const heldSource = fs.readFileSync(path.resolve(__dirname, '../OrderNotes.vue'), 'utf8');
  const heldCardSource = fs.readFileSync(path.resolve(__dirname, '../OrderNoteCard.vue'), 'utf8');
  const cardStart = source.indexOf('data-testid="table-card"');
  const cardEnd = source.indexOf('<!-- Empty table state -->');
  const cardSource = source.slice(cardStart, cardEnd);

  it('uses the POS device theme and restrained semantic table states', () => {
    expect(source).toContain("{ 'pos-theme-dark': isPosDark }");
    expect(source).toContain("localStorage.getItem('pos_theme') === 'dark'");
    expect(source).toContain('.tables-page.pos-theme-dark');
    expect(source).toContain('.table-card--available { --table-status: #2d6a4f; }');
    expect(source).toContain('.table-card--occupied { --table-status: #ad4c45; }');
    expect(source).toContain('.table-card--printed { --table-status: #3d699b; }');
    expect(source).toContain('background: var(--table-status);');
    expect(source).toContain('color: #fff;');
    expect(source).toContain('background: var(--tables-surface-muted);');
    expect(source).toContain('background: var(--tables-card);\n  color: var(--tables-ink);');
    expect(source).toContain('#24405e');
    expect(source).not.toContain('#0f766e');
    expect(source).toContain('repeat(5, minmax(0, 1fr))');
    expect(source).toContain('repeat(8, minmax(0, 1fr))');
    expect(source).not.toContain('bg-gradient-to');
    expect(source).not.toContain('from-emerald-500');
    expect(source).not.toContain('shadow-2xl');
  });

  it('keeps held orders inside the same POS shell and tactile control vocabulary', () => {
    expect(heldSource).toContain("{ 'pos-theme-dark': isPosDark }");
    expect(heldSource).toContain("localStorage.getItem('pos_theme') === 'dark'");
    expect(heldSource).toContain('.order-notes-page.pos-theme-dark');
    expect(heldSource).toContain('box-shadow: inset 0 -2px 0 var(--notes-tactile-edge);');
    expect(heldSource).toContain('--notes-card: #f9fafb;');
    // The order dialog draws from the page tokens, so it follows the dark theme without overrides.
    expect(heldSource).not.toMatch(/text-slate-|bg-rose-|bg-amber-/);
    // Dividers are the top edge of the following row, so a later row's fill cannot cover them.
    expect(heldCardSource).toMatch(/\.note-card \+ \.note-card \{\s*border-top: 1px solid/);
    expect(heldCardSource).not.toMatch(/\.note-card \{[^}]*border-bottom: 1px solid/);
    expect(heldCardSource).toContain('box-shadow: 0 2px 0 var(--notes-tactile-edge');
    expect(heldCardSource).toContain('background: var(--notes-surface-muted');
    expect(heldSource).toContain('notes-source-filter');
    expect(heldCardSource).toContain('note-card__source');
  });

  it('does not repeat status labels inside table cards', () => {
    expect(cardStart).toBeGreaterThan(-1);
    expect(cardEnd).toBeGreaterThan(cardStart);
    expect(cardSource).not.toContain("$t('Available')");
    expect(cardSource).not.toContain("$t('Occupied')");
    expect(cardSource).not.toContain("$t('Bill Printed')");
  });

  it('keeps semantic controls and removes the redundant zone label', () => {
    expect(source).toContain('data-testid="tables-navigation-menu"');
    expect(source).toContain('data-testid="table-card"');
    expect(source).toContain('role="dialog"');
    expect(source).toContain(':aria-label="getTableOptionsLabel(table)"');
    expect(source).not.toContain("$t('Zone')");
  });
});
