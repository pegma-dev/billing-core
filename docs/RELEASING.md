# Release operations

`@pegma/billing-core` publishes only from a stable GitHub release. Merging a
pull request never publishes, and the workflow has no manual-dispatch or
npm-token fallback.

## Required external configuration

Before the first release through this workflow:

- configure `@pegma/billing-core` on npm with the GitHub Actions trusted
  publisher `pegma-dev/billing-core`, workflow `publish.yml`, environment
  `npm-publish`, and allowed action `npm publish`;
- create the GitHub `npm-publish` environment. A second reviewer is not
  required under Pegma's single-maintainer policy;
- create the repository Actions variable `RELEASE_ALLOWED_SIGNERS` containing
  the reviewed Git SSH allowed-signers entry for the maintainer's release key;
  this is public-key material, not a secret; and
- create an active tag ruleset targeting `v*` that prevents tag updates and
  deletions and limits tag creation to the release maintainer.

Do not add `NODE_AUTH_TOKEN`, an npm automation token, or another credential
fallback. After one trusted-publisher release is verified, disable any
remaining traditional npm publish tokens.

## Release procedure

The version in `packages/billing-core/package.json` is the release version.
Change it through an ordinary reviewed pull request and run the complete gate
on Node 22 and 24.

After that pull request is merged, create a signed annotated tag at the exact
`origin/main` commit, push the tag, verify the fetched tag, and only then
create the GitHub release with `--verify-tag`. Do not let GitHub create the tag
and never move or recreate a release tag.

The release workflow verifies that the tag:

- is a stable annotated `vX.Y.Z` tag signed by an allowed signer;
- matches the package version;
- points to the checkout and the GitHub release-event commit; and
- is contained in `origin/main`.

Its preparation job has no OIDC permission. It installs the reviewed npm
`11.18.0` release and the pinned pnpm without dependency caching, runs the
full gate, builds and packs once with that npm CLI, smoke-tests the tarball
from a clean consumer, records its SHA-1 and SHA-512 integrity, and uploads
the exact prepared artifacts. The lockfile source of truth is `pnpm-lock.yaml`.

Only the `npm-publish` job receives `id-token: write`. It installs no
dependencies and does not download pnpm. It runs
`node scripts/release-packages.mjs publish`, verifies the prepared manifest
and tarball hashes against the release commit, and publishes those tarballs
with npm provenance.

## Safe retry

The workflow is globally serialized. Re-run the failed release jobs against
the unchanged tag:

- an absent version is published;
- an existing version with identical `dist.integrity` is verified and skipped;
- a different integrity, or any registry error other than `E404`, stops the
  release.

Never unpublish and reuse a version. If any released byte must change, prepare
a new version and a new signed tag.
