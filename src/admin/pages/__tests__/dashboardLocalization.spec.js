import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('Dashboard localization contract', () => {
    const componentDir = path.resolve(__dirname, '../../components/dashboard');
    const files = fs.existsSync(componentDir)
        ? fs.readdirSync(componentDir)
            .filter(name => name.endsWith('.vue'))
            .map(name => path.join(componentDir, name))
        : [];
    const sources = [path.resolve(__dirname, '../Dashboard.vue'), ...files]
        .filter(fs.existsSync)
        .map(file => fs.readFileSync(file, 'utf8'))
        .join('\n');
    const dictionary = JSON.parse(fs.readFileSync(
        path.resolve(process.cwd(), 'src/shared/i18n/ar.json'),
        'utf8'
    ));

    it('has Arabic entries for static dashboard translation keys', () => {
        const keys = [...sources.matchAll(/\$t\(\s*['"]([^'"]+)['"]\s*\)/g)].map(match => match[1]);
        const arabicKeys = new Set(Object.keys(dictionary));
        expect([...new Set(keys)].filter(key => !arabicKeys.has(key))).toEqual([]);
    });

    it('covers dynamic narrative and attention templates', () => {
        const required = [
            'Sales are {percent}% ahead of a typical {weekday}.',
            'Sales are {percent}% behind a typical {weekday}.',
            'Sales are close to a typical {weekday}.',
            'More orders caused most of the increase.',
            'Higher average checks caused most of the increase.',
            'Fewer orders caused most of the difference.',
            'Lower average checks caused most of the difference.',
            'Refunds are higher than usual: {amount}.',
            'Voids are higher than usual: {amount}.',
            'Discounts are higher than usual: {amount}.',
            'One closed register is {amount} {direction}.',
            '{count} products are low in stock.',
        ];
        const arabicKeys = new Set(Object.keys(dictionary));
        expect(required.filter(key => !arabicKeys.has(key))).toEqual([]);
    });
});
