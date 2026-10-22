# Fake Idan Releases

This public repository is the distribution and updater trust boundary for the
native Fake Idan desktop companion. The first release boundary supports Apple
Silicon macOS 11+ (`darwin-aarch64`) and connects to
**https://fakeidan.com**. Private source remains in **Epoch-ML/zerg** under
`zapps/fakeidan`; this repository holds reviewed release requests, public
artifacts, independent channel updater public keys, and GitHub Pages feeds.

The desktop microphone entitlement is limited to recording voice messages the user chooses to
send. macOS asks for permission when recording starts; the application declares that purpose in
its Info.plist. The signing and fresh-extraction checks require that exact purpose and audio-input
entitlement. No camera, screen-capture, general file-read, or shell entitlement is added.

## Release flow

1. A protected **fakeidan-v\*** or **fakeidan-preview-v\*** source tag runs the
   secret-free source workflow and produces one deterministic JSON request.
   Its timestamp is the canonical UTC rendering of the exact source commit
   timestamp.
2. A human reviews and merges a pull request adding only
   **requests/&lt;tag&gt;.json** as a single-parent commit, then creates the protected
   public tag at that exact request-addition commit. The release workflow is
   manually dispatched from **main** with that request path.
3. A credential-free Apple Silicon build checks out the exact private source
   SHA and matching source tag using an environment-scoped read-only deploy
   key. It compares both source updater public keys to this repository's
   independent trust roots, tests and audits the source, generates the exact
   channel release configuration, and builds an unsigned app.
4. A fresh macOS job checks out only this public repository, validates and
   extracts the source archive with path, type, count, compressed-size, and
   uncompressed-size limits, and never executes the untrusted archive before
   extraction validation. Preview apps are ad-hoc signed. Stable apps receive
   Developer ID signing, notarization, and stapling in an isolated environment.
5. A separate Ubuntu job checks out only this public repository and exposes one
   channel updater private key to a single Tauri signer command. Private source
   and updater private keys never coexist.
6. The publisher creates an immutable GitHub Release, uploads only missing
   assets, and verifies exact names and bytes. Retried runs resume only when
   metadata, tag target, asset set, and every existing byte match.
7. Only after the released bytes revalidate does a fresh feed job advance the
   selected channel on protected **release-data**. GitHub Pages is deployed from
   one deterministic artifact, then the live HTTPS manifest is byte-compared.

Canonical updater endpoints (a channel exists only after its first promotion):

- Stable: https://epoch-ml.github.io/fakeidan-releases/stable/latest.json
- Preview: https://epoch-ml.github.io/fakeidan-releases/preview/latest.json
- Immutable metadata: `CHANNEL/releases/VERSION.json`

The feed cannot move backward. Tags, release assets, release versions, and
reviewed request bytes are immutable.

### Pages branch topology

Before the first release, cutover may contain only the root `.nojekyll` and `index.html` files.
Each `preview` or `stable` subtree is optional; if present, must contain `latest.json` plus at least one matching `releases/VERSION.json`.
Live preflight requires at least one complete channel subtree.
The preflight accepts only bounded regular blobs and trees. Symlinks, special
entries, unrelated files, legacy root feeds, and partial channel groups fail
closed.

The custom OIDC deployment client calls the GitHub Pages Deployments API and
does not cancel a queued deployment when its local wait expires, allowing an
idempotent retry to observe the same deployment.

## Repository configuration

Repository-wide Actions secrets: **none**.

Build and Apple environments:

- **fakeidan-preview-build**: `ZERG_SOURCE_DEPLOY_KEY` only (read-only
  `Epoch-ML/zerg` deploy key).
- **fakeidan-stable-build**: `ZERG_SOURCE_DEPLOY_KEY` only.
- **fakeidan-apple-preview**: no secrets; ad-hoc signing only.
- **fakeidan-apple-stable**:
  - `FAKEIDAN_APPLE_CERTIFICATE`
  - `FAKEIDAN_APPLE_CERTIFICATE_PASSWORD`
  - `FAKEIDAN_APPLE_SIGNING_IDENTITY`
  - `FAKEIDAN_APPLE_API_ISSUER`
  - `FAKEIDAN_APPLE_API_KEY_ID`
  - `FAKEIDAN_APPLE_API_PRIVATE_KEY`

Updater and feed environments:

- **fakeidan-preview-updater**:
  - `FAKEIDAN_PREVIEW_TAURI_SIGNING_PRIVATE_KEY`
  - `FAKEIDAN_PREVIEW_TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
- **fakeidan-stable-updater**:
  - `FAKEIDAN_STABLE_TAURI_SIGNING_PRIVATE_KEY`
  - `FAKEIDAN_STABLE_TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
- **fakeidan-feed**: `FAKEIDAN_FEED_DEPLOY_KEY` only, scoped to protected
  `release-data`.

Pinned deploy-key identities:

- **Fake Idan releases source checkout 2026** —
  `SHA256:Aeq8RN+XAGjbQcs6ScBxkgUr+PXm2IxU3TxVUHvamxA` (read-only source key).
- **Fake Idan release feed writer 2026** —
  `SHA256:u18QHvF5XRwZjPRca+tKo4R3zaHXuu22l8xK5AV2W1k` (release-data writer).

Preview and stable installations embed distinct updater roots:

- [keys/fakeidan-preview-updater.pubkey](keys/fakeidan-preview-updater.pubkey)
- [keys/fakeidan-stable-updater.pubkey](keys/fakeidan-stable-updater.pubkey)

The private source repository has one secret-free
**fakeidan-release-request** environment scoped only to protected
**fakeidan-v\*** and **fakeidan-preview-v\*** tags. It has no public repository
write credential and no Apple or updater signing secret.

Required controls:

- Preview/stable build and updater environments, plus stable Apple signing,
  require the owning human reviewer.
- Release and source tags reject updates and deletion and may be created only
  by the owning human.
- Immutable GitHub Releases is enabled.
- `main` requires a pull request; only the owning human may bypass it.
- `main` and `release-data` reject force pushes and deletion.
- The feed writer is an independent branch-scoped deploy key.

Apple Developer ID and notarization credentials come from the owning team.
Never commit, print, or transfer private keys through artifacts.

### Native dependency audit scope

This repository publishes only `aarch64-apple-darwin` applications. Before building, the native
audit obtains Cargo's locked dependency resolver graph for that exact target with the release
build's `tauri/custom-protocol` feature enabled. If the macOS
runner uses a different native Darwin architecture, its host graph is included as well so build
dependencies remain covered. Every resolved package identity and dependency edge must match the
original committed lockfile; the temporary audit lock preserves the original versions, sources,
and registry checksums. Missing, ambiguous, duplicate, or inconsistent graph data fails closed.

The normal `cargo audit` scanner runs on that complete target/host projection without package
exclusions or advisory ignores. Platform-only dependencies absent from both resolved graphs are
outside this Mac artifact's audit scope. A vulnerable package becomes blocking if either graph
resolves it, including ZIP and TLS packages. Supporting another publication platform requires its
own complete resolver graph and audit; the Mac projection is not an audit of Windows binaries.

## Initial rollout

Qualify the initial stable Mac download with the notarized stable pair:

1. Publish and install `0.1.0` from its canonical public installer.
2. Publish `0.1.1`, then verify the installed `0.1.0` application downloads,
   verifies, stages, and installs that update through the stable feed.

Preview is a separate, ad-hoc signed channel and does not inherit stable
qualification. Before promoting a future preview download, independently prove
the same native update sequence from `0.1.0-preview.2` to `0.1.0-preview.3`.
The earlier preview attempt failed before signing or publication, so it is not
evidence of a working preview installer or updater.

Do not publish or dispatch a release until every required environment and
source-side policy passes live preflight.

## Local verification

```bash
npm ci
npm audit --audit-level=moderate
npm test
actionlint .github/workflows/*.yml
```

Non-trivial script changes additionally run the scoped Stryker commands listed
in `package.json`. Generated mutation and dependency directories are ignored.
