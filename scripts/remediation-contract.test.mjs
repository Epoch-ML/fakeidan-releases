import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parse } from "yaml";

const release = parse(await readFile(
  new URL("../.github/workflows/release.yml", import.meta.url),
  "utf8",
));
const anchor = parse(await readFile(
  new URL("../.github/workflows/policy-anchor.yml", import.meta.url),
  "utf8",
));

function step(job, name) {
  const matches = (release.jobs[job]?.steps ?? []).filter(
    (candidate) => candidate.name === name,
  );
  assert.equal(matches.length, 1, `${job} must contain one ${name} step`);
  return matches[0];
}

test("commits canonical LF-terminated updater roots", async () => {
  for (const name of ["preview", "stable"]) {
    const bytes = await readFile(
      new URL(`../keys/fakeidan-${name}-updater.pubkey`, import.meta.url),
    );
    assert.equal(bytes.at(-1), 10, `${name} root must end in LF`);
    assert.notEqual(bytes.at(-2), 10, `${name} root must have one trailing LF`);
    const encoded = bytes.toString("utf8").trim();
    assert.match(encoded, /^[A-Za-z0-9+/]+={0,2}$/);
    assert.equal(Buffer.from(encoded, "base64").toString("base64"), encoded);
  }
});

test("compares canonical dot-named source roots without raw-byte coupling", () => {
  const compare = step(
    "build-macos",
    "Compare both tag-selected updater keys with independent trust roots",
  );
  assert.match(compare.run, /src-tauri\/updater\.preview\.pubkey/);
  assert.match(compare.run, /src-tauri\/updater\.stable\.pubkey/);
  assert.match(compare.run, /readFile[\s\S]*\.trim\(\)/);
  assert.match(compare.run, /canonical base64/);
  assert.doesNotMatch(compare.run, /cmp --silent/);

  const config = step(
    "build-macos",
    "Write and verify the FakeIdan release configuration",
  );
  assert.match(config.run, /updater\.stable\.pubkey/);
  assert.match(config.run, /updater\.preview\.pubkey/);
  assert.match(config.run, /committedKey\.trim\(\)/);
  assert.match(config.run, /trustedKey\.trim\(\)/);
  assert.match(config.run, /createUpdaterArtifacts, false/);
});

test("keeps the remote-backed companion free of local automation payloads", () => {
  const build = release.jobs["build-macos"];
  const serialized = JSON.stringify(build);
  assert.doesNotMatch(
    serialized,
    /source\/ztc|ztc-capture|meeting-bridge|release:stage|desktop-runtime/,
  );
  const verify = step(
    "build-macos",
    "Verify the exact bundled FakeIdan release assets",
  );
  assert.match(verify.run, /Contents\/MacOS\/fakeidan/);
  assert.match(verify.run, /find "\$app" -type l/);
  assert.match(verify.run, /find "\$app" ! -type d ! -type f/);
});

test("audits the exact locked source package without an auxiliary runtime", () => {
  const install = step("build-macos", "Install locked dependencies and security tooling");
  assert.match(
    install.run,
    /npm ci --prefix source\/zapps\/fakeidan/,
  );
  const gate = step("build-macos", "Test and audit the exact source");
  assert.match(
    gate.run,
    /npm --prefix source\/zapps\/fakeidan audit --omit=dev --audit-level=moderate/,
  );
  assert.match(gate.run, /npm run test:release --prefix source\/zapps\/fakeidan/);
  assert.doesNotMatch(gate.run, /source\/ztc|meeting-runtime/);
});

test("compiles the selected updater channel and request version", () => {
  const build = step(
    "build-macos",
    "Build the unsigned app without release signing credentials",
  );
  assert.equal(
    build.env.FAKEIDAN_UPDATE_CHANNEL,
    "${{ needs.validate.outputs.channel }}",
  );
  assert.equal(
    build.env.FAKEIDAN_VERSION,
    "${{ needs.validate.outputs.version }}",
  );
  assert.match(build.run, /--config src-tauri\/tauri\.release\.conf\.json/);
  const config = step(
    "build-macos",
    "Write and verify the FakeIdan release configuration",
  );
  assert.equal(config.env.FAKEIDAN_VERSION, "${{ needs.validate.outputs.version }}");
  assert.match(config.run, /npm run release:config/);
});

test("validates base identity before generating release-only configuration", () => {
  const bind = step(
    "build-macos",
    "Bind source desktop identity to the public entitlement contract",
  );
  assert.match(bind.run, /productName[\s\S]*Fake Idan/);
  assert.match(bind.run, /identifier[\s\S]*com\.zergai\.fakeidan/);
  assert.doesNotMatch(bind.run, /beforeBuildCommand/);
  assert.doesNotMatch(bind.run, /release:stage/);
});

test("accepts reviewed routine lock inputs without weakening immutable policy", () => {
  assert.deepEqual(anchor.on.pull_request_target.types, [
    "opened",
    "reopened",
    "synchronize",
    "labeled",
    "unlabeled",
  ]);
  const job = anchor.jobs["anchored-policy"];
  const review = job.steps.find(
    (candidate) => candidate.name === "Resolve head-bound independent review",
  );
  assert.deepEqual(review.env, {
    APPROVAL_LABEL: "fakeidan-release-policy-reviewed",
    EVENT_ACTION: "${{ github.event.action }}",
    EVENT_LABEL: "${{ github.event.label.name || '' }}",
    EVENT_SENDER: "${{ github.event.sender.login }}",
    EVENT_SENDER_TYPE: "${{ github.event.sender.type }}",
    PR_AUTHOR: "${{ github.event.pull_request.user.login }}",
    REPOSITORY_READ_TOKEN: "${{ github.token }}",
    RUN_ATTEMPT: "${{ github.run_attempt }}",
    TRIGGERING_ACTOR: "${{ github.triggering_actor }}",
  });
  assert.match(
    review.run,
    /EVENT_ACTION" == "labeled"[\s\S]*RUN_ATTEMPT" == "1"[\s\S]*TRIGGERING_ACTOR" == "\$EVENT_SENDER"[\s\S]*EVENT_SENDER" != "\$PR_AUTHOR"/,
  );
  assert.match(review.run, /\.role_name[\s\S]*admin[\s\S]*maintain[\s\S]*write/);
  assert.match(review.run, /mktemp[\s\S]*chmod 600[\s\S]*curl --config/);
  assert.doesNotMatch(review.run, /pull_request\.labels/);

  const materialize = job.steps.find(
    (candidate) => candidate.name === "Materialize only bounded candidate data",
  );
  assert.equal(
    materialize.env.ROUTINE_PROTECTED_CHANGE_APPROVED,
    "${{ steps.protected-input-review.outputs.approved }}",
  );
  assert.match(materialize.run, /"\$ROUTINE_PROTECTED_CHANGE_APPROVED"/);
});

test("keeps derived Git authorization out of process arguments", () => {
  const fetch = anchor.jobs["anchored-policy"].steps.find(
    (candidate) => candidate.name ===
      "Fetch the immutable pull request objects without checkout",
  );
  assert.match(fetch.run, /GIT_CONFIG_COUNT/);
  assert.match(fetch.run, /GIT_CONFIG_VALUE_0/);
  assert.match(fetch.run, /unset REPOSITORY_READ_TOKEN authorization/);
  assert.doesNotMatch(fetch.run, /-c "\$header_key=AUTHORIZATION: basic \$authorization"/);
});
