import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parse } from "yaml";

const repositoryRoot = new URL("../", import.meta.url).pathname;
const workflow = parse(await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8"));
const auditStep = workflow.jobs["build-macos"].steps.find(({ name }) => name === "Test and audit the exact source");

async function qualifyAudit({ vulnerableTls = false, reachableZip = false, malformed, hostZip = false } = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "fakeidan-macos-audit-")));
  try {
    const source = join(directory, "source/zapps/fakeidan/src-tauri");
    await mkdir(source, { recursive: true });
    await mkdir(join(directory, "bin"));
    await symlink(repositoryRoot, join(directory, "release-repository"));
    const tlsVersion = vulnerableTls ? "0.23.43" : "0.23.46";
    await writeFile(join(source, "Cargo.toml"), '[package]\nname = "fakeidan"\nversion = "0.1.0"\n');
    await writeFile(join(source, "Cargo.lock"), `version = 3

[[package]]
name = "fakeidan"
version = "0.1.0"
dependencies = ["rustls", "zip"]

[[package]]
name = "rustls"
version = "${tlsVersion}"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "${"a".repeat(64)}"

[[package]]
name = "zip"
version = "4.6.1"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "${"b".repeat(64)}"
`);
    const registry = "registry+https://github.com/rust-lang/crates.io-index";
    const root = "path+file:///fixture#fakeidan@0.1.0";
    const tls = `${registry}#rustls@${tlsVersion}`;
    const zip = `${registry}#zip@4.6.1`;
    const makeMetadata = includeZip => ({
      version: 1,
      workspace_members: [root],
      packages: [
        { id: root, name: "fakeidan", version: "0.1.0", source: null, manifest_path: join(source, "Cargo.toml") },
        { id: tls, name: "rustls", version: tlsVersion, source: registry },
        ...(includeZip ? [{ id: zip, name: "zip", version: "4.6.1", source: registry }] : []),
      ],
      resolve: {
        root,
        nodes: [
          { id: root, dependencies: [tls, ...(includeZip ? [zip] : [])] },
          { id: tls, dependencies: [] },
          ...(includeZip ? [{ id: zip, dependencies: [] }] : []),
        ],
      },
    });
    const metadata = makeMetadata(reachableZip);
    if (malformed === "unresolved") metadata.resolve.nodes[0].dependencies.push("registry+https://example.invalid#missing@1.0.0");
    if (malformed === "duplicate") metadata.packages.push(metadata.packages[1]);
    if (malformed === "mismatch") metadata.packages[1].source = "registry+https://example.invalid/index";
    if (malformed === "no-root") metadata.resolve.root = null;
    await writeFile(join(directory, "metadata.json"), JSON.stringify(metadata));
    await writeFile(join(directory, "host-metadata.json"), JSON.stringify(makeMetadata(hostZip || reachableZip)));
    // Cargo/rustc/npm are subprocess boundaries. The scanner evaluates the supplied lock bytes,
    // so dropping a reachable vulnerable package changes an observable successful audit result.
    await writeFile(join(directory, "bin/npm"), "#!/bin/sh\nexit 0\n");
    await writeFile(join(directory, "bin/rustc"), `#!/bin/sh\nprintf 'rustc 1.94.1\\nhost: ${hostZip ? "x86_64" : "aarch64"}-apple-darwin\\n'\n`);
    await writeFile(join(directory, "bin/cargo"), `#!${process.execPath}
import { readFile } from "node:fs/promises";
const args = process.argv.slice(2);
if (args[0] === "metadata") {
  if (!args.includes("--locked") || !args.includes("--filter-platform") || args[args.indexOf("--features") + 1] !== "tauri/custom-protocol") process.exit(42);
  const host = args[args.indexOf("--filter-platform") + 1] === "x86_64-apple-darwin";
  process.stdout.write(await readFile(host ? process.env.HOST_METADATA : process.env.TARGET_METADATA));
} else if (args[0] === "audit") {
  if (args.some(value => value.startsWith("--ignore"))) process.exit(43);
  const lock = await readFile(args[args.indexOf("--file") + 1], "utf8");
  const packages = [...lock.matchAll(/\\[\\[package\\]\\]\\s*([\\s\\S]*?)(?=\\[\\[package\\]\\]|$)/g)].map(match => ({ name: match[1].match(/^name = "([^"]+)"/m)[1], version: match[1].match(/^version = "([^"]+)"/m)[1] }));
  console.log(JSON.stringify({ audited: packages.map(p => p.name).sort() }));
  const vulnerable = packages.filter(p => (p.name === "zip" && p.version === "4.6.1") || (p.name === "rustls" && p.version === "0.23.43"));
  if (vulnerable.length > 0) { console.error("vulnerable packages: " + vulnerable.map(p => p.name).join(",")); process.exit(17); }
}
`);
    for (const name of ["npm", "rustc", "cargo"]) await chmod(join(directory, "bin", name), 0o755);
    const result = spawnSync("bash", ["-c", auditStep.run], {
      cwd: directory,
      env: { ...process.env, SOURCE_APP_DIR: "source/zapps/fakeidan", PATH: `${join(directory, "bin")}:${process.env.PATH}`, RUNNER_TEMP: directory, TARGET_METADATA: join(directory, "metadata.json"), HOST_METADATA: join(directory, "host-metadata.json") },
      encoding: "utf8",
      timeout: 10_000,
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("the macOS audit includes every resolved target package and excludes Windows-only ZIP", async () => {
  const result = await qualifyAudit();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"audited":\["fakeidan","rustls"\]/);
});

test("reachable vulnerable TLS remains release-blocking", async () => {
  const result = await qualifyAudit({ vulnerableTls: true });
  assert.equal(result.status, 17, result.stderr);
  assert.match(result.stderr, /vulnerable packages: rustls/);
});

test("ZIP remains release-blocking if the supported platform actually resolves it", async () => {
  const result = await qualifyAudit({ reachableZip: true });
  assert.equal(result.status, 17, result.stderr);
  assert.match(result.stderr, /vulnerable packages: zip/);
});

test("a different native Darwin host contributes its build graph to the audit", async () => {
  const result = await qualifyAudit({ hostZip: true });
  assert.equal(result.status, 17, result.stderr);
  assert.match(result.stderr, /vulnerable packages: zip/);
});

for (const malformed of ["unresolved", "duplicate", "mismatch", "no-root"]) {
  test(`malformed ${malformed} metadata fails before the advisory scanner runs`, async () => {
    const result = await qualifyAudit({ malformed });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /macos-cargo-audit:/);
    assert.doesNotMatch(result.stdout, /"audited":/);
  });
}
