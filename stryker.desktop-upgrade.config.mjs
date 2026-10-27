export default {
  cleanTempDir: 'always',
  concurrency: 2,
  coverageAnalysis: 'off',
  mutate: ['scripts/desktop-upgrade.mjs:29:0-54:1', 'scripts/desktop-upgrade.mjs:58:0-95:1'],
  packageManager: 'npm',
  reporters: ['clear-text', 'progress', 'json'],
  testRunner: 'command',
  commandRunner: { command: 'node --test scripts/desktop-upgrade.test.mjs' },
  thresholds: { break: null, high: 80, low: 60 },
  timeoutMS: 5000,
};
