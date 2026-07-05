// Shared ESLint flat config for the Terminull monorepo.
// Re-exported from the repo root (../eslint.config.js) so every package lints
// against one source of truth.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import i18next from 'eslint-plugin-i18next';
import globals from 'globals';

export default tseslint.config(
  {
    // Never lint build output, deps, generated assets, config files, or the
    // harness/tooling scratch directories (not part of the monorepo source).
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/*.config.js',
      '**/*.config.ts',
      '**/coverage/**',
      '.claude/**',
      '.goal-ledger/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // TypeScript already resolves identifiers, so the core no-undef rule is
    // redundant and produces false positives on ambient globals.
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-undef': 'off',
    },
  },
  {
    // Test files use loose fixtures; relax a couple of rules there.
    files: ['**/*.test.ts', '**/*.test.tsx'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    // Browser globals for the web package sources.
    files: ['packages/web/src/**/*.{ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
  },
  {
    // i18n hardcoded-string guard: ONLY for the web app's JSX sources.
    // A literal Korean/English string rendered directly in JSX must instead go
    // through a translation key (useTranslation). Object-literal string values
    // (e.g. the i18n resource files) are NOT flagged because the rule is scoped
    // to JSX markup only via `markupOnly`.
    files: ['packages/web/src/**/*.tsx'],
    plugins: { i18next },
    rules: {
      'i18next/no-literal-string': [
        'error',
        {
          markupOnly: true,
          ignoreAttribute: ['data-testid', 'className', 'id', 'type', 'role'],
        },
      ],
    },
  },
);
