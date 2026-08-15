# Contributing to Billing Core

Thank you for helping improve Billing Core.

## Before opening an issue

- Search existing issues for related work.
- Use GitHub's private vulnerability reporting flow for security concerns.
- Describe the ledger behaviour you need and which refusal it must not
  violate (arrival-order application, payment processing, entitlements,
  receipt dedup, invoicing/tax/metering, or storing card data / payloads /
  amounts).
- If a proposal needs this package to process payments or to create a
  provider adapter before a consumer exists, say so explicitly — those are
  the changes the design cannot absorb.

## Local development

Billing Core requires Node.js 22 or 24. Corepack is bundled through Node 24;
on Node 25 or newer, install it first.

```sh
npm install -g corepack
corepack enable
pnpm install --frozen-lockfile
pnpm run check
pnpm test
pnpm run format:check
```

## Pull requests

Keep pull requests focused. Include:

- the problem being solved;
- the intended ledger behavior;
- race cases for any apply decision a host may rely on;
- documentation for public API changes.

A behaviour that is not asserted against memory and real Azurite is not
part of the contract.

## License

By contributing, you agree that your contributions will be licensed under the
MIT License.
