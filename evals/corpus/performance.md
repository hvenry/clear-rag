# Performance

## Latency budgets

Every user-facing endpoint has a p99 latency budget, and the budget is part of
the endpoint's definition rather than something discovered later. Gateway
enforces a hard timeout of thirty seconds, but an endpoint approaching that has
already failed as far as the user is concerned.

The standing budgets are 200ms p99 for reads, 500ms p99 for writes, and two
seconds for anything that fans out to a third party. An endpoint over budget for
a full week becomes a SEV3 and gets an owner.

## The usual culprits

Most latency problems are one of three things, in descending order of frequency.

The first is an N+1 query: code that loads a collection and then issues one
query per item. It is invisible in development against ten rows and fatal in
production against ten thousand. Traces make it obvious — an N+1 shows up as a
picket fence of identical short spans.

The second is a missing index. Any query filtering or sorting on a column
without an index will eventually become the slowest thing in the system. Every
migration adding a query pattern should add the index in the same change.

The third is doing work in the request path that could be done afterwards.
Sending an email, writing an audit record, and recalculating a derived total are
all things a caller should not wait for; publish an event and let Notifier or a
worker handle it.

## Caching

Cache when the read-to-write ratio is high and staleness is acceptable, and be
explicit about how stale is acceptable before adding the cache rather than after.

Ledger balance reads are cached with a five second time-to-live. Five seconds
was chosen because it is short enough that no human notices and long enough to
absorb the burst of reads that follows a transfer.

Never cache authorisation decisions. A revoked permission that stays effective
for even a short window is a security defect, not a performance optimisation.

## Load testing

Load tests run against staging before any change expected to alter the traffic
shape. The test replays a recorded production trace at a configurable multiple,
because synthetic traffic with a uniform distribution does not resemble real
traffic and will not find the problems real traffic finds.

A load test is only meaningful if staging is sized like production. Staging runs
at one third of production capacity, so results are compared as a ratio rather
than as absolute numbers.
