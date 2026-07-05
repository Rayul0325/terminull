/**
 * Shared Prettier configuration for the Terminull monorepo.
 * Re-exported from the repo root so every package formats identically.
 * @type {import('prettier').Config}
 */
const config = {
  printWidth: 100,
  singleQuote: true,
  semi: true,
  trailingComma: 'all',
  arrowParens: 'always',
  endOfLine: 'lf',
};

export default config;
