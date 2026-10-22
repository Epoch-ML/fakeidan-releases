import assert from "node:assert/strict";
import test from "node:test";

import fc from "fast-check";
import { parse, stringify } from "smol-toml";

import { projectMacosCargoLock } from "./audit-macos-cargo.mjs";

const registry = "registry+https://github.com/rust-lang/crates.io-index";
const manifest = "/fixture/Cargo.toml";

function fixture(versions = ["1.2.3"]) {
  const packages = versions.map((version, index) => ({
    id: `${registry}#dependency-${index}@${version}`,
    name: `dependency-${index}`,
    version,
    source: registry,
  }));
  const root = { id: "path+file:///fixture#fakeidan@0.1.0", name: "fakeidan", version: "0.1.0", source: null, manifest_path: manifest };
  const nodes = [root, ...packages].map((value, index) => ({ id: value.id, dependencies: packages[index] === undefined ? [] : [packages[index].id] }));
  const lock = {
    version: 3,
    package: [
      { name: root.name, version: root.version, dependencies: packages.length === 0 ? [] : [`${packages[0].name} ${packages[0].version}`] },
      ...packages.map((value, index) => ({ name: value.name, version: value.version, source: registry, checksum: "a".repeat(64), dependencies: packages[index + 1] === undefined ? [] : [`${packages[index + 1].name} ${packages[index + 1].version}`] })),
      { name: "windows-only", version: "1.0.0", source: registry, checksum: "b".repeat(64) },
    ],
  };
  const graph = { version: 1, packages: [root, ...packages], workspace_members: [root.id], resolve: { root: root.id, nodes } };
  return { lock, graph };
}

// Projection conserves every reachable identity/checksum and is idempotent.
test("Cargo graph projection conserves the resolved dependency closure", () => {
  fc.assert(fc.property(fc.array(fc.tuple(fc.integer({ min: 0, max: 20 }), fc.integer({ min: 0, max: 20 }), fc.integer({ min: 0, max: 100 })).map(([major, minor, patch]) => `${major}.${minor}.${patch}`), { maxLength: 20 }), versions => {
    const { lock, graph } = fixture(versions);
    const projected = projectMacosCargoLock(stringify(lock), [graph], manifest);
    const parsed = parse(projected.text);
    assert.deepEqual(parsed.package.map(value => [value.name, value.version, value.source ?? null, value.checksum ?? null]), lock.package.slice(0, -1).map(value => [value.name, value.version, value.source ?? null, value.checksum ?? null]));
    assert.equal(projected.count, versions.length + 1);
    assert.equal(projectMacosCargoLock(projected.text, [graph], manifest).text, projected.text);
  }), { numRuns: 50 });
});

test("audit projection rejects empty locks and unsupported graph and identity shapes", () => {
  const canonical = fixture();
  assert.throws(() => projectMacosCargoLock("", [canonical.graph], manifest), /unsupported Cargo lock version/);
  assert.throws(() => projectMacosCargoLock("version = 3\npackage = [", [canonical.graph], manifest), /invalid TOML/);
  assert.throws(() => projectMacosCargoLock(stringify(canonical.lock), [], manifest), /expected the macOS target/);
  for (const mutate of [
    value => { value.version = 99; },
    value => { value.package = []; },
    value => { value.package.push(value.package[0]); },
    value => { value.package[1].version = "wrong"; },
    value => { value.package[1].checksum = "wrong"; },
    value => { value.package[0].dependencies = ["unknown"]; },
  ]) {
    const { lock, graph } = fixture();
    mutate(lock);
    assert.throws(() => projectMacosCargoLock(stringify(lock), [graph], manifest), /Cargo|registry/);
  }
  for (const mutate of [
    value => { value.resolve.nodes.push(value.resolve.nodes[0]); },
    value => { value.resolve.nodes[0].dependencies.push(value.resolve.nodes[0].dependencies[0]); },
    value => { value.resolve.nodes[0].dependencies = []; },
    value => { value.packages[0].manifest_path = "/another/Cargo.toml"; },
    value => { value.workspace_members = []; },
    value => { value.packages[1].source = "registry+https://other.invalid/index"; },
  ]) {
    const { lock, graph } = fixture();
    mutate(graph);
    assert.throws(() => projectMacosCargoLock(stringify(lock), [graph], manifest), /Cargo/);
  }
});

test("metadata cannot add an edge absent from the original lock", () => {
  const { lock, graph } = fixture(["1.0.0", "2.0.0"]);
  graph.resolve.nodes[0].dependencies.push(graph.resolve.nodes[2].id);
  assert.throws(() => projectMacosCargoLock(stringify(lock), [graph], manifest), /resolve edge is absent from the original lock/);
});
