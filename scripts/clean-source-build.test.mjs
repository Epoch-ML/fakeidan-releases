import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parse } from "yaml";

const workflow = parse(await readFile(
  new URL("../.github/workflows/release.yml", import.meta.url),
  "utf8",
));
const buildSteps = workflow.jobs["build-macos"].steps;

async function runDependencyStep({ failClientBuild = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "fakeidan-clean-source-"));
  try {
    await mkdir(join(directory, "bin"));
    await mkdir(join(directory, "release-repository"));
    await mkdir(join(directory, "source/zapps/zergbox/client"), { recursive: true });
    await mkdir(join(directory, "source/zapps/fakeidan/scripts/mobile-tools"), { recursive: true });
    // npm is the process boundary: model its file-dependency link and sibling build output.
    const npm = join(directory, "bin/npm");
    await writeFile(npm, `#!${process.execPath}
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const args = process.argv.slice(2);
const prefixIndex = args.indexOf("--prefix");
const prefix = prefixIndex === -1 ? process.cwd() : resolve(args[prefixIndex + 1]);
if (prefix.endsWith("/source/zapps/zergbox") && args.includes("ci")) {
  await writeFile(resolve(prefix, "dependencies-installed"), "locked dependencies");
}
if (prefix.endsWith("/source/zapps/zergbox") && args.includes("client:build")) {
  await readFile(resolve(prefix, "dependencies-installed"));
  if (process.env.FAIL_CLIENT_BUILD === "true") {
    console.error("client compiler failed: fixture syntax error");
    process.exit(41);
  }
  await mkdir(resolve(prefix, "client/dist"), { recursive: true });
  await writeFile(resolve(prefix, "client/package.json"), JSON.stringify({ type: "module", exports: "./dist/index.js" }));
  await writeFile(resolve(prefix, "client/dist/index.js"), 'export const projectionName = name => "projection:" + name;');
}
if (prefix.endsWith("/source/zapps/fakeidan/scripts/mobile-tools") && args.includes("ci")) {
  await writeFile(resolve(prefix, "runtime-closure.json"), JSON.stringify({ yaml: "2.9.1", pngjs: "7.0.0" }));
}
if (prefix.endsWith("/source/zapps/fakeidan") && args.includes("ci")) {
  let closure = {};
  try { closure = JSON.parse(await readFile(resolve(prefix, "scripts/mobile-tools/runtime-closure.json"), "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  console.log("mobile-tools:" + JSON.stringify(closure));
  await mkdir(resolve(prefix, "node_modules/@zergai"), { recursive: true });
  await symlink(resolve(prefix, "../zergbox/client"), resolve(prefix, "node_modules/@zergai/zergbox-client"));
  await writeFile(resolve(prefix, "verify.mjs"), 'import { projectionName } from "@zergai/zergbox-client"; console.log(projectionName("qualified-source"));');
  await import(resolve(prefix, "verify.mjs"));
}
`);
    await chmod(npm, 0o755);
    const cargo = join(directory, "bin/cargo");
    await writeFile(cargo, "#!/bin/sh\nexit 0\n");
    await chmod(cargo, 0o755);
    const step = buildSteps.find(({ name }) => name === "Install locked dependencies and security tooling");
    const result = spawnSync("bash", ["-c", step.run], {
      cwd: directory,
      env: {
        ...process.env,
        PATH: `${join(directory, "bin")}:${process.env.PATH}`,
        FAIL_CLIENT_BUILD: String(failClientBuild),
      },
      encoding: "utf8",
      timeout: 10_000,
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("a pristine source checkout can resolve the built local ZergBox client before app preparation", async () => {
  const result = await runDependencyStep();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^projection:qualified-source$/m);
});

test("a sibling client build failure stops the release instead of using an absent or stale projection", async () => {
  const result = await runDependencyStep({ failClientBuild: true });
  assert.equal(result.status, 41, result.stderr);
  assert.match(result.stderr, /client compiler failed: fixture syntax error/);
  assert.doesNotMatch(result.stdout, /projection:qualified-source/);
});

test("the pinned release Rust compiler supports the locked macOS notification dependency", () => {
  const step = buildSteps.find(({ name }) => name === "Install pinned Rust toolchain");
  const installed = step.run.match(/rustup toolchain install (\d+)\.(\d+)\.(\d+)/);
  assert.notEqual(installed, null, "release compiler must use an exact stable version");
  const [, major, minor] = installed.map(Number);
  // notify-rust 4.18.0 is in the locked Darwin graph and declares Rust 1.89.0.
  assert.ok(major > 1 || (major === 1 && minor >= 89), `locked macOS notification dependency requires Rust >=1.89.0; release pins ${installed[0]}`);
  assert.match(step.run, new RegExp(`rustup default ${installed[1]}\\.${installed[2]}\\.${installed[3]}(?:\\s|$)`));
});


test("source app preparation installs the locked mobile fixture runtime before release tests", async () => {
  const result = await runDependencyStep();
  assert.equal(result.status, 0, result.stderr);
  const line = result.stdout.split("\n").find(value => value.startsWith("mobile-tools:"));
  assert.deepEqual(JSON.parse(line.slice("mobile-tools:".length)), { yaml: "2.9.1", pngjs: "7.0.0" });
});
