import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

import { parse } from "yaml";

const workflow = parse(await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8"));
const publicationJobs = [
  ["publish", ["validate", "sign-updater"]],
  ["promote-feed", ["validate", "publish"]],
  ["deploy-pages", ["validate", "promote-feed"]],
];

function scheduled(job, needs, cancelled = false) {
  // GitHub scheduling is the process boundary: an implicit success() also sees the deliberately skipped unselected signer.
  let condition = job.if ?? "success()";
  if (!/\b(?:always|cancelled|failure|success)\s*\(/.test(condition)) {
    condition = `success() && (${condition})`;
  }
  condition = condition.replace(/needs\.([\w-]+)/g, "needs['$1']");
  return Boolean(runInNewContext(condition, {
    needs,
    always: () => true,
    cancelled: () => cancelled,
    success: () => !cancelled && Object.values(needs).every(({ result }) => result === "success"),
  }, { timeout: 100 }));
}

for (const [jobName, requiredNeeds] of publicationJobs) {
  test(`${jobName} proceeds after its successful prerequisites despite the intentionally skipped other channel`, () => {
    const job = workflow.jobs[jobName];
    assert.deepEqual(job.needs, requiredNeeds);
    for (const channel of ["stable", "preview"]) {
      const otherChannel = channel === "stable" ? "preview" : "stable";
      const needs = Object.fromEntries(requiredNeeds.map((name) => [name, { result: "success" }]));
      needs.validate.outputs = { channel };
      needs[`sign-updater-${otherChannel}`] = { result: "skipped" };
      assert.equal(scheduled(job, needs), true, `${jobName} must run for the successful ${channel} release`);
    }
  });

  test(`${jobName} remains blocked by cancellation or any unsuccessful required prerequisite`, () => {
    const job = workflow.jobs[jobName];
    const successful = Object.fromEntries(requiredNeeds.map((name) => [name, { result: "success" }]));
    assert.equal(scheduled(job, successful, true), false, "cancelled workflows must not publish or promote");
    for (const name of requiredNeeds) {
      for (const result of ["failure", "skipped", "cancelled"]) {
        const needs = { ...successful, [name]: { result } };
        assert.equal(scheduled(job, needs), false, `${name}=${result} must block ${jobName}`);
      }
    }
  });
}
