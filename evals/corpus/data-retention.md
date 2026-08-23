# Data Retention and Backups

## Backups

Postgres is backed up continuously via write-ahead log shipping, with a base
snapshot taken nightly at 02:00 UTC. This gives point-in-time recovery to any
second within the retention window.

The retention window is thirty-five days. Anything older than that is gone, and
there is no archival tier — a request to recover data from six months ago cannot
be satisfied, which surprises people and is worth saying out loud during
onboarding.

Restores are rehearsed quarterly against a scratch environment. A backup that
has never been restored is a hypothesis, not a backup, and the rehearsal exists
to keep that hypothesis tested. The last rehearsal restored a full production
snapshot in fifty-one minutes.

## Object storage

Uploaded documents live in object storage with versioning enabled. Deleting an
object creates a delete marker rather than removing the bytes; the bytes are
purged thirty days later by a lifecycle rule.

Object storage is replicated to a second bucket in the same region. This
protects against accidental deletion, not against a regional outage — the
regional isolation described in the architecture guide applies here too.

## Deleting a tenant

A tenant deletion request starts a two-phase process. Phase one marks the tenant
inactive and stops all processing immediately; the data still exists. Phase two
runs after a fourteen day grace period and performs the irreversible deletion.

The grace period exists because deletion requests are occasionally made in error
and, unlike almost everything else here, this one cannot be undone. A tenant can
be restored at any point during the grace period by the platform team.

Ledger entries are the exception. Financial records are retained for seven years
regardless of a deletion request, as required by regulation. They are pseudonymised
during phase two — the tenant identifier is replaced with an opaque token — but
the entries themselves remain.

## Personal data

Personally identifiable information is confined to two tables in the gateway
schema, both of which are documented in the data catalogue. Any change adding
personal data to a new location requires review from the security group.

Logs are scrubbed at write time and metrics never contain personal data at all,
which is the other reason metric labels must not include tenant identifiers.
