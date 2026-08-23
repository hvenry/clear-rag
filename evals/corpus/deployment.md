# Deploying Harbour

All deployments go through the `hb` command line tool. Direct pushes to any
environment are blocked; the only path to production is a merged pull request
that has passed continuous integration.

## Environments

There are three environments. `dev` redeploys automatically on every merge to
main and its data is wiped nightly. `staging` mirrors production configuration
and holds a scrubbed copy of production data refreshed each Sunday. `production`
requires an explicit promotion.

## Promoting a build

Once a pull request merges, CI publishes a container image tagged with the
commit SHA. Promote it with:

    hb deploy --env production --sha <commit-sha>

The command opens a canary by default: five percent of traffic is routed to the
new build for fifteen minutes while error rate and p99 latency are compared
against the previous release. If either regresses beyond the configured
threshold the canary is abandoned automatically and no further traffic shifts.

A healthy canary is promoted to the full fleet in three waves of roughly one
third each, with a two minute soak between waves.

## Undoing a bad release

If a release needs to be reverted, run:

    hb deploy --rollback

This repoints traffic at the previously known-good image. It does not revert
database migrations, which is the single most important thing to understand
about it — a release containing a destructive migration cannot be safely undone
by this command, and recovering from one requires restoring from a snapshot.

For that reason, migrations must be backwards compatible with the previous
release. Adding a column is fine; dropping one requires two separate releases,
the first stopping all writes to the column and the second removing it.

## Deployment windows

Production deployments are permitted between 09:00 and 16:00 in the deployer's
local time, Monday through Thursday. Friday deploys require sign-off from the
on-call engineer. This is a guideline rather than an enforced lock, and it is
routinely waived for security patches.
