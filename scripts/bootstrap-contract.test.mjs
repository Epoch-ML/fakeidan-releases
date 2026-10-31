import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

const requiredFiles = [
  ".github/workflows/policy-anchor.yml",
  ".github/workflows/policy.yml",
  ".github/workflows/release.yml",
  "README.md",
  "SECURITY.md",
  "keys/fakeidan-preview-updater.pubkey",
  "keys/fakeidan-stable-updater.pubkey",
  "macos/FakeIdan.entitlements.plist",
  "scripts/anchored-policy.mjs",
  "scripts/repository-preflight.mjs",
  "scripts/workflow-policy.mjs",
  "scripts/source-app-path.mjs",
];

describe("FakeIdan public release boundary", () => {
  it("ships every independently reviewable trust-boundary component", () => {
    const missing = requiredFiles.filter((path) => !existsSync(path));
    assert.deepEqual(missing, [], `missing release-boundary files: ${missing.join(", ")}`);

    const workflow = readFileSync(".github/workflows/release.yml", "utf8");
    assert.match(workflow, /source-app-path\.mjs/);
    assert.match(workflow, /fakeidan-preview-updater/);
    assert.match(workflow, /\$\{PACKAGING_ASSET_PREFIX\}_\$\{VERSION\}_aarch64\.app\.tar\.gz/);
  });
});
