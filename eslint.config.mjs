import pluginVue from 'eslint-plugin-vue';
import globals from 'globals';

export default [
  { ignores: ['dist/**', 'node_modules/**', 'scratch/**', 'pos-spooler-printer/**', 'integrations/**', 'backend/**', 'scripts/**', 'docs/**', '**/*.cjs'] },
  ...pluginVue.configs['flat/essential'],
  {
    files: ['src/**/*.{js,mjs,vue}'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.browser } },
    rules: {
      'vue/no-lone-template': 'error',
      'vue/multi-word-component-names': 'off',
    },
  },
];
