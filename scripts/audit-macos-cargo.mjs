#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { valid } from "semver";
import { parse, stringify } from "smol-toml";

const TARGET = "aarch64-apple-darwin";
const MAX_LOCK_BYTES = 8 * 1024 * 1024;
const MAX_METADATA_BYTES = 16 * 1024 * 1024;
const MAX_PACKAGES = 4096;

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function boundedString(value, maximum = 2048) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && !value.includes("\0");
}

function packageIdentity(value) {
  requireValue(value !== null && typeof value === "object" && !Array.isArray(value), "Cargo package must be an object");
  requireValue(boundedString(value.name, 128) && /^[A-Za-z0-9_-]+$/.test(value.name), "invalid Cargo package name");
  requireValue(boundedString(value.version, 128) && valid(value.version) !== null, "invalid Cargo package version");
  const source = value.source ?? null;
  requireValue(source === null || boundedString(source), "invalid Cargo package source");
  return JSON.stringify([value.name, value.version, source]);
}

function resolveLockedDependency(specification, packages) {
  requireValue(boundedString(specification), "invalid locked Cargo dependency");
  const match = specification.match(/^([A-Za-z0-9_-]+)(?: ([^ ()]+))?(?: \(([^()]+)\))?$/);
  requireValue(match !== null, "invalid locked Cargo dependency format");
  const candidates = packages.filter(value => value.name === match[1] &&
    (match[2] === undefined || value.version === match[2]) &&
    (match[3] === undefined || value.source === match[3]));
  requireValue(candidates.length === 1, "unresolved or ambiguous locked Cargo dependency");
  return packageIdentity(candidates[0]);
}

export function projectMacosCargoLock(lockText, graphs, manifestPath) {
  requireValue(typeof lockText === "string" && Buffer.byteLength(lockText) <= MAX_LOCK_BYTES, "Cargo lock exceeds its byte boundary");
  let lock;
  try { lock = parse(lockText); } catch { throw new Error("Cargo lock is invalid TOML"); }
  requireValue(lock.version === 3 || lock.version === 4, "unsupported Cargo lock version");
  requireValue(Array.isArray(lock.package) && lock.package.length > 0 && lock.package.length <= MAX_PACKAGES, "invalid Cargo lock package count");
  const locked = new Map();
  for (const value of lock.package) {
    const identity = packageIdentity(value);
    requireValue(!locked.has(identity), "duplicate locked Cargo package");
    requireValue(value.dependencies === undefined || (Array.isArray(value.dependencies) && value.dependencies.length <= MAX_PACKAGES), "invalid locked Cargo dependency list");
    if (value.source !== undefined && value.source.startsWith("registry+")) {
      requireValue(typeof value.checksum === "string" && /^[0-9a-f]{64}$/.test(value.checksum), "registry Cargo package has no canonical checksum");
    }
    locked.set(identity, value);
  }
  requireValue(Array.isArray(graphs) && graphs.length >= 1 && graphs.length <= 2, "expected the macOS target and optional native host graph");
  const included = new Map();
  let expectedRoot;
  for (const graph of graphs) {
    requireValue(graph !== null && typeof graph === "object" && graph.version === 1, "invalid Cargo metadata version");
    requireValue(Array.isArray(graph.packages) && graph.packages.length > 0 && graph.packages.length <= MAX_PACKAGES, "invalid Cargo metadata package count");
    requireValue(graph.resolve !== null && typeof graph.resolve === "object" && boundedString(graph.resolve.root), "unresolved Cargo metadata root");
    requireValue(Array.isArray(graph.workspace_members) && graph.workspace_members.includes(graph.resolve.root), "Cargo root is not a workspace member");
    requireValue(Array.isArray(graph.resolve.nodes) && graph.resolve.nodes.length > 0 && graph.resolve.nodes.length <= MAX_PACKAGES, "invalid Cargo resolve graph");
    const packages = new Map();
    for (const value of graph.packages) {
      requireValue(boundedString(value.id) && !packages.has(value.id), "duplicate or invalid Cargo metadata package ID");
      const identity = packageIdentity(value);
      requireValue(locked.has(identity), "Cargo metadata package does not match the original lock identity");
      packages.set(value.id, { value, identity });
    }
    const nodes = new Map();
    for (const value of graph.resolve.nodes) {
      requireValue(value !== null && typeof value === "object" && boundedString(value.id) && !nodes.has(value.id), "duplicate or invalid Cargo resolve node");
      requireValue(packages.has(value.id) && Array.isArray(value.dependencies) && value.dependencies.length <= MAX_PACKAGES && value.dependencies.every(id => boundedString(id)), "unresolved Cargo dependency node");
      requireValue(new Set(value.dependencies).size === value.dependencies.length, "duplicate Cargo dependency edge");
      nodes.set(value.id, value);
    }
    const root = packages.get(graph.resolve.root);
    requireValue(root !== undefined && root.value.name === "fakeidan" && root.value.source === null && root.value.manifest_path === manifestPath, "Cargo metadata root does not match the requested Fake Idan manifest");
    requireValue(expectedRoot === undefined || expectedRoot === root.identity, "native host and target Cargo roots differ");
    expectedRoot = root.identity;
    const queue = [graph.resolve.root];
    const visited = new Set();
    while (queue.length > 0) {
      const id = queue.pop();
      if (visited.has(id)) continue;
      visited.add(id);
      const node = nodes.get(id);
      requireValue(node !== undefined, "unresolved Cargo dependency edge");
      const entry = packages.get(id);
      const original = locked.get(entry.identity);
      const allowed = new Set((original.dependencies ?? []).map(specification => resolveLockedDependency(specification, lock.package)));
      const dependencies = included.get(entry.identity) ?? new Set();
      for (const dependency of node.dependencies) {
        const target = packages.get(dependency);
        requireValue(target !== undefined && nodes.has(dependency), "unresolved Cargo dependency edge");
        requireValue(allowed.has(target.identity), "Cargo resolve edge is absent from the original lock");
        dependencies.add(target.identity);
        queue.push(dependency);
      }
      included.set(entry.identity, dependencies);
    }
    requireValue(visited.size === nodes.size && visited.size === packages.size, "Cargo metadata contains unreachable or unresolved package nodes");
  }
  const packageEntries = lock.package.filter(value => included.has(packageIdentity(value))).map(value => {
    const dependencies = [...included.get(packageIdentity(value))].map(identity => {
      const target = locked.get(identity);
      return `${target.name} ${target.version}${target.source === undefined ? "" : ` (${target.source})`}`;
    }).sort();
    const result = { ...value };
    if (dependencies.length > 0) result.dependencies = dependencies;
    else delete result.dependencies;
    return result;
  });
  requireValue(packageEntries.length === included.size, "projected Cargo audit graph lost a resolved package");
  return { text: stringify({ version: lock.version, package: packageEntries }), count: packageEntries.length };
}

async function readBounded(path) {
  const info = await stat(path);
  requireValue(info.isFile() && info.size > 0 && info.size <= MAX_LOCK_BYTES, "Cargo lock exceeds its file boundary");
  return readFile(path, "utf8");
}

function runOutput(program, args) {
  const result = spawnSync(program, args, { encoding: "utf8", maxBuffer: MAX_METADATA_BYTES, timeout: 120_000 });
  requireValue(result.error === undefined && result.status === 0, `${program} failed while resolving the locked Cargo graph`);
  return result.stdout;
}

async function main() {
  requireValue(process.argv.length === 3, "usage: audit-macos-cargo.mjs PATH/TO/Cargo.toml");
  const manifest = await realpath(resolve(process.argv[2]));
  const lockPath = join(dirname(manifest), "Cargo.lock");
  const original = await readBounded(lockPath);
  const hostMatch = runOutput("rustc", ["-vV"]).match(/^host: (aarch64|x86_64)-apple-darwin$/m);
  requireValue(hostMatch !== null, "Mac publication must run on a supported native Darwin host");
  const host = `${hostMatch[1]}-apple-darwin`;
  const platforms = host === TARGET ? [TARGET] : [TARGET, host];
  const graphs = platforms.map(platform => JSON.parse(runOutput("cargo", ["metadata", "--locked", "--format-version", "1", "--filter-platform", platform, "--features", "tauri/custom-protocol", "--manifest-path", manifest])));
  requireValue(await readBounded(lockPath) === original, "source Cargo lock changed during target resolution");
  const projection = projectMacosCargoLock(original, graphs, manifest);
  const temporary = await mkdtemp(join(process.env.RUNNER_TEMP ?? tmpdir(), "fakeidan-macos-cargo-audit-"));
  try {
    const auditLock = join(temporary, "Cargo.lock");
    await writeFile(auditLock, projection.text, { flag: "wx", mode: 0o600 });
    console.log(`Auditing ${projection.count} locked Cargo packages resolved for ${platforms.join(" and ")}.`);
    const result = spawnSync("cargo", ["audit", "--file", auditLock], { stdio: "inherit", timeout: 300_000 });
    requireValue(result.error === undefined && result.status !== null, "Cargo advisory scanner could not complete");
    process.exitCode = result.status;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && await realpath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`macos-cargo-audit: ${error.message}`);
    process.exitCode = 1;
  });
}
