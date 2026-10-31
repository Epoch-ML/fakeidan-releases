export default {
 cleanTempDir:'always',concurrency:1,coverageAnalysis:'off',mutate:['scripts/source-app-path.mjs'],packageManager:'npm',
 reporters:['clear-text','json'],jsonReporter:{fileName:'reports/mutation/source-app-path.json'},
 testRunner:'command',commandRunner:{command:'node --test scripts/source-app-path.test.mjs'},
 thresholds:{break:null,high:80,low:60},timeoutMS:20000,
};
