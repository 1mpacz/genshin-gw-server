import js from '@eslint/js';
import * as tseslint from 'typescript-eslint';
import parser from '@typescript-eslint/parser';
import globals from 'globals';

export default [
  {
    ignores: ['node_modules', 'dist'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser,
      parserOptions: {
        project: './tsconfig.json',
        sourceType: 'module',
      },
      globals: {
        ...globals.node,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': 'warn',
      'no-console': 'off',
    },
  },
];
