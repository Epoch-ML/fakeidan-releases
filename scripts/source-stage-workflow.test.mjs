import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

import { prepareSourceStage } from "./source-stage.mjs";

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const workflow = parse(await readFile(join(repository, ".github/workflows/release.yml"), "utf8"));
const buildSteps = workflow.jobs["build-macos"].steps;
const sourceSha = "0123456789abcdef0123456789abcdef01234567";

async function withBuildFixture(channel, callback, { wrongSourceKey = false } = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "fakeidan-source-stage-workflow-")));
  try {
    const application = join(directory, "source/zapps/fakeidan");
    const tauri = join(application, "src-tauri");
    const app = join(tauri, "target/aarch64-apple-darwin/release/bundle/macos/Fake Idan.app");
    await mkdir(join(app, "Contents/MacOS"), { recursive: true });
    await mkdir(join(directory, "bin"));
    await mkdir(join(directory, "release-repository/scripts"), { recursive: true });
    await mkdir(join(directory, "release-repository/keys"));
    await writeFile(join(directory, "release-repository/scripts/package-macos.mjs"), await readFile(join(repository, "scripts/package-macos.mjs")));
    await writeFile(join(directory, "release-repository/scripts/release-packaging.mjs"), await readFile(join(repository, "scripts/release-packaging.mjs")));
    await symlink(join(repository, "node_modules"), join(directory, "release-repository/node_modules"));
    for (const channelName of ["preview", "stable"]) {
      const keyName = `fakeidan-${channelName}-updater.pubkey`;
      await writeFile(join(directory, "release-repository/keys", keyName), await readFile(join(repository, "keys", keyName)));
    }
    await writeFile(join(app, "Contents/Info.plist"), "fixture plist parsed on the macOS runner\n");
    await writeFile(join(app, "Contents/MacOS/fakeidan"), "fixture native bytes");
    await chmod(join(app, "Contents/MacOS/fakeidan"), 0o755);
    const publicKeyPath = join(repository, `keys/fakeidan-${channel}-updater.pubkey`);
    const trustedKey = await readFile(publicKeyPath, "utf8");
    const sourceKey = wrongSourceKey ? Buffer.from("untrusted updater key").toString("base64") : trustedKey.trim();
    await writeFile(join(tauri, `updater.${channel}.pubkey`), sourceKey);
    const version = channel === "stable" ? "0.1.9" : "0.1.9-preview.1";
    const releaseTag = channel === "stable" ? `fakeidan-v${version}` : `fakeidan-preview-v${version}`;
    await writeFile(join(tauri, "tauri.release.conf.json"), JSON.stringify({
      productName: "Fake Idan",
      build: { frontendDist: "https://bot.zergai.com/desktop" },
      identifier: "com.zergai.fakeidan",
      version,
      plugins: { updater: {
        endpoints: [`https://epoch-ml.github.io/fakeidan-releases/${channel}/latest.json`],
        pubkey: sourceKey,
      } },
      bundle: { createUpdaterArtifacts: false },
    }));
    // npm is the process boundary; configuration bytes are supplied as the source build would emit them.
    await writeFile(join(directory, "bin/npm"), "#!/bin/sh\nexit 0\n");
    await chmod(join(directory, "bin/npm"), 0o755);
    const env = {
      ...process.env,
      PATH: `${join(directory, "bin")}:${process.env.PATH}`,
      GITHUB_WORKSPACE: directory,
      PACKAGING_PRODUCT_NAME: "Fake Idan",
      PACKAGING_APP_BUNDLE: "Fake Idan.app",
      PACKAGING_ASSET_PREFIX: "FakeIdan",
      PACKAGING_SOURCE_PRODUCT_NAME: "Zerg Bot",
      PACKAGING_DESKTOP_URL: "https://bot.zergai.com/desktop",
      FAKEIDAN_UPDATE_CHANNEL: channel,
      FAKEIDAN_VERSION: version,
      FAKEIDAN_DESKTOP_VERSION: version,
      FAKEIDAN_RELEASE_TAG: releaseTag,
      FAKEIDAN_SOURCE_SHA: sourceSha,
    };
    const runStep = (name) => spawnSync("bash", ["-c", buildSteps.find((step) => step.name === name).run], {
      cwd: application, env, encoding: "utf8", timeout: 10_000,
    });
    await callback({
      runStep,
      trustedKey,
      stage: {
        inputDirectory: join(application, "dist/source-stage"),
        outputDirectory: join(directory, "extracted"),
        publicKeyPath,
        request: { channel, releaseTag, sourceSha, version },
      },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

for (const channel of ["preview", "stable"]) {
  test(`the ${channel} build stages the bound public root bytes when the source key omits its trailing newline`, async () => {
    await withBuildFixture(channel, async ({ runStep, trustedKey, stage }) => {
      const binding = runStep("Write and verify the FakeIdan release configuration");
      assert.equal(binding.status, 0, binding.stderr);
      const packaging = runStep("Package a bounded unsigned source stage");
      assert.equal(packaging.status, 0, packaging.stderr);
      const result = await prepareSourceStage(stage);
      assert.equal(await readFile(join(result.applicationPath, "Contents/MacOS/fakeidan"), "utf8"), "fixture native bytes");
      assert.equal(await readFile(join(stage.inputDirectory, "updater.pubkey"), "utf8"), trustedKey);
      assert.equal(result.metadata.source_sha, sourceSha);
    });
  });

  test(`the ${channel} build rejects a different source key before source-stage packaging`, async () => {
    await withBuildFixture(channel, async ({ runStep }) => {
      const binding = runStep("Write and verify the FakeIdan release configuration");
      assert.notEqual(binding.status, 0);
      assert.match(binding.stderr, /AssertionError.*Expected values to be strictly equal/s);
    }, { wrongSourceKey: true });
  });
}
