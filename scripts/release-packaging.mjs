import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import semver from 'semver';

/** Publisher-owned profiles; requests never choose names independently. */
export function releasePackaging(version) {
  if (typeof version !== 'string' || semver.valid(version) !== version) {
    throw new Error('packaging version must be canonical SemVer');
  }
  const core = `${semver.major(version)}.${semver.minor(version)}.${semver.patch(version)}`;
  const renamed = semver.gte(core, '0.2.0');
  const bridge = semver.gte(core, '0.1.2');
  return Object.freeze({
    productName: renamed ? 'Zerg Bot' : 'Fake Idan',
    releaseName: renamed ? 'Zerg Bot' : 'FakeIdan',
    applicationName: renamed ? 'Zerg Bot.app' : 'Fake Idan.app',
    assetPrefix: renamed ? 'ZergBot' : 'FakeIdan',
    sourceProductName: bridge ? 'Zerg Bot' : 'Fake Idan',
    desktopUrl: bridge ? 'https://bot.zergai.com/desktop' : 'https://fakeidan.com/desktop',
  });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const profile = releasePackaging(process.argv[2]);
  if (process.argv.length !== 3) throw new Error('usage: release-packaging.mjs VERSION');
  if (process.env.GITHUB_OUTPUT) {
    const output = [
      `product_name=${profile.productName}`,
      `release_name=${profile.releaseName}`,
      `app_bundle=${profile.applicationName}`,
      `asset_prefix=${profile.assetPrefix}`,
      `source_product_name=${profile.sourceProductName}`,
      `desktop_url=${profile.desktopUrl}`,
    ].join('\n');
    await appendFile(process.env.GITHUB_OUTPUT, output + '\n');
  }
  process.stdout.write(JSON.stringify(profile) + '\n');
}
