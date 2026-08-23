# Testing

## What to write

Most tests should be unit tests over pure functions, because they are fast,
deterministic, and fail with a message that tells you what broke. Integration
tests exercising a service against a real Postgres are valuable but slow, and
end-to-end tests spanning multiple services are so slow and so flaky that
Harbour keeps fewer than thirty of them in total.

The shape to aim for is a lot of cheap tests, some medium ones, and a small
number of expensive ones — and to push each test down to the cheapest level that
can still catch the bug you are worried about.

## Fixtures

Test data is built by factories, not by fixture files. A factory produces a valid
object with sensible defaults and lets a test override only the fields it cares
about, which keeps the test readable: everything the test names is relevant, and
everything it does not name is irrelevant.

Shared mutable fixture files are the usual cause of a test that passes alone and
fails in a suite. If a test depends on the ordering of the suite, it is broken
even while it is green.

## Flaky tests

A test that fails intermittently is quarantined the same day it is noticed. It
is moved out of the required set, a ticket is opened with the owning team, and
it must be fixed or deleted within two weeks. Quarantine is not a parking space.

Retrying a failing test until it passes is forbidden in continuous integration.
A flake is a real defect somewhere — usually a race, a shared fixture, or a
dependence on wall-clock time — and retrying hides the information you need.

## Speed

The full suite must complete in under twelve minutes. This is a hard budget: a
pull request that takes the suite over it is not merged until it is brought back
under, even if the tests themselves are correct.

Tests run in parallel across eight workers. Anything that binds a fixed port,
writes to a fixed path, or assumes an empty database will fail under parallelism,
and those assumptions are the most common source of a test that only fails in CI.

## Coverage

Coverage is measured and reported but not enforced with a threshold. A number
that must be kept above a line produces tests written to move the number, which
are worse than no tests because they cost maintenance and catch nothing.
