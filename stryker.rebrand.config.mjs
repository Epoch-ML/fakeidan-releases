export default {
  cleanTempDir: 'always', concurrency: 2, coverageAnalysis: 'off',
  mutate: ['scripts/release-packaging.mjs'], packageManager: 'npm',
  reporters: ['clear-text', 'progress', 'json'],
  testRunner: 'command', commandRunner: { command: 'node --test scripts/release-packaging.test.mjs scripts/rebrand-packaging.test.mjs scripts/rebrand-workflow.test.mjs scripts/source-stage.test.mjs' },
  thresholds: { break: null, high: 80, low: 60 }, timeoutMS: 10000,
};
