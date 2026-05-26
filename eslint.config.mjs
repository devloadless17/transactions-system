// Flat ESLint config — root-only. Keeps things minimal: TypeScript-aware,
// no project-references-required mode, no React rules (Next has its own
// `next lint` for the web app via `pnpm --filter @app/web lint`).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default [
  {
    ignores: [
      'node_modules',
      '**/dist/**',
      '**/.next/**',
      '**/build/**',
      'packages/db/generated',
      // Next.js project lints itself.
      'apps/web/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': ['warn', { prefer: 'type-imports' }],
      'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],
    },
  },
];
