import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";

const repositoryRoot = new URL("../", import.meta.url);

async function collectTextFiles(directoryUrl) {
  const entries = await readdir(directoryUrl, { withFileTypes: true });
  const paths = [];
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const entryUrl = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directoryUrl);
    if (entry.isDirectory()) {
      paths.push(...await collectTextFiles(entryUrl));
    } else {
      paths.push(entryUrl);
    }
  }
  return paths;
}

describe("Fake Idan public release boundary", () => {
  it("binds the repository, source path, bundle, and channel tag grammar", async () => {
    const workflow = await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
    assert.match(workflow, /Publish Zerg Bot Desktop Release/);
    assert.match(workflow, /Epoch-ML\/fakeidan-releases/);
    assert.match(workflow, /\$\{SOURCE_APP_DIR\}\/src-tauri\/tauri\.conf\.json/);
    assert.match(workflow, /com\.zergai\.fakeidan/);
    assert.match(workflow, /requests\/fakeidan-\(preview-\)\?v/);
    assert.match(workflow, /darwin-aarch64/);
  });

  it("contains no legacy ZergMeeting product identifiers outside shared tag policy", async () => {
    const paths = await collectTextFiles(repositoryRoot);
    const findings = [];
    for (const path of paths) {
      if (path.pathname.endsWith("/scripts/fakeidan-bootstrap-contract.test.mjs")) continue;
      const text = (await readFile(path, "utf8"))
        .replaceAll('"refs/tags/zergmeeting-preview-v*",', "")
        .replaceAll('"refs/tags/zergmeeting-v*",', "");
      if (/zergmeeting|zerg meeting|zergmeet\.com|com\.zergai\.meeting/i.test(text)) {
        findings.push(join(path.pathname));
      }
    }
    assert.deepEqual(findings, []);
  });
});
