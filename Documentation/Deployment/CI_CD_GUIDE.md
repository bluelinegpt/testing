# CI/CD Guide

## Implemented CI

`.github/workflows/ci.yml` is a GitHub Actions validation baseline. It becomes active only if GitHub is approved as the source-control platform. It uses read-only repository permissions and does not receive production secrets.

Pull requests and pushes to `main` run:

1. Frozen dependency installation.
2. Supported credential-signature scan.
3. Migration naming/order validation.
4. Formatting, linting, strict type checking, tests, and builds.
5. Production dependency vulnerability audit.
6. API and web container builds.

`pnpm ci:validate` is provider-neutral and can be used by another CI platform if GitHub is not selected.

## Deployment Stages

No staging or production deployment job is enabled because the source host, image registry, cloud provider, environments, approval owners, and application release gates are unresolved.

After approval, add separate jobs with this order:

1. Build once and sign/version immutable images by commit SHA.
2. Scan images and publish to the approved private registry.
3. Deploy the same images to staging and run migrations using a one-off controlled job.
4. Run readiness, smoke, security, and critical workflow tests.
5. Require owner approval for production.
6. Take/verify a database backup, run the approved migration, deploy images, and verify health.
7. Monitor the release window and record evidence.

Production must never deploy directly from a pull request, rebuild an already approved image, or continue after a failed migration or readiness check.
