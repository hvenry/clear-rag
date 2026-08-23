# Harbour Platform Architecture

Harbour is composed of three long-running services plus a small set of shared
data stores. Every service is stateless and horizontally scalable; all durable
state lives in Postgres or in object storage.

## Services

**Gateway** terminates TLS, authenticates requests, and routes them to the
appropriate downstream service. It is the only service exposed to the public
internet. Gateway enforces a default rate limit of 600 requests per minute per
API key, which can be raised per-tenant by the platform team.

**Ledger** owns all monetary records. It is the system of record for balances,
transfers, and reconciliation. Ledger never exposes a mutable API — every
balance change is written as an append-only entry, and current balances are
derived by folding the entry log. This makes the service slower to query than a
mutable table would be, and it is the reason balance reads are cached.

**Notifier** delivers email, SMS, and webhook notifications. It is intentionally
best-effort: a failed delivery is retried with exponential backoff for up to six
hours, after which the message is written to a dead-letter queue and an alert
fires. Notifier is the only service permitted to make outbound calls to third
parties.

## Data stores

Postgres 16 is the primary database. Each service owns its own schema and no
service reads another service's tables directly; cross-service reads go through
the owning service's API. There is a single writable primary with two read
replicas in the same region.

Redis holds derived balance data and session tokens. Nothing in Redis is
authoritative — the cache can be flushed at any time without data loss, though
doing so will cause a latency spike while it refills.

NATS carries asynchronous events between services. Events are published on
subjects namespaced by the owning service, for example `ledger.transfer.created`.
Consumers are expected to be idempotent because NATS gives at-least-once
delivery, not exactly-once.

## Regions

Harbour runs in two regions, `eu-west-1` and `us-east-1`. Regions are fully
isolated: there is no cross-region replication, and a tenant is pinned to a
single region at signup. Moving a tenant between regions is a manual migration
performed by the platform team and takes roughly four hours.
