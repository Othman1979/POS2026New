import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('POS expense entry contract', () => {
    const terminal = fs.readFileSync(path.resolve(__dirname, '../../PosTerminal.vue'), 'utf8');
    const modalPath = path.resolve(__dirname, '../ExpenseModal.vue');

    it('gates the action by permission and mounts a dedicated modal', () => {
        expect(terminal).toContain("can('pos.expenses')");
        expect(terminal).toContain('ExpenseModal');
        expect(fs.existsSync(modalPath)).toBe(true);
    });

    it('keeps the amount control and modal layout aligned in both directions', () => {
        const modal = fs.readFileSync(modalPath, 'utf8');

        expect(modal).toContain('min="0"');
        expect(modal).not.toContain('min="0.01"');
        expect(modal).toContain("amount.value === ''");
        expect(modal).not.toContain('!amount.value');
        expect(modal).toContain('.expense-amount:focus-within');
        expect(modal).toContain('grid-template-columns: minmax(0, 1fr) auto');
        expect(modal).not.toContain('border-inline-end: 0');
        expect(modal).toContain('max-height: calc(100dvh - 2rem)');
        expect(modal).toContain('overflow-y: auto');
    });
});
