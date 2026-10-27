#!/usr/bin/env node

export class UpgradeQualificationError extends Error {}

export function verifyUpgradeEvidence() {
  return { qualified: false, reason: 'An installed public update has not been proved.' };
}
