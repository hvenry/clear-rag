# API Guidelines

## Versioning

The API is versioned in the path, as `/v1/`. A version is supported for
twenty-four months after its successor ships, and the deprecation date is
returned in a `Sunset` header on every response from a deprecated version well
before it is enforced.

Breaking changes require a new version. Adding an optional field, adding a new
endpoint, and adding a new value to a response enum are all non-breaking.
Removing a field, making an optional field required, and changing a field's type
are all breaking, and so is tightening validation on an existing field.

## Pagination

Collections are cursor-paginated, never offset-paginated. Offset pagination
produces duplicated and skipped records whenever the underlying collection
changes between pages, which for an append-heavy system like Ledger is
constantly.

The default page size is fifty and the maximum is five hundred. A response
includes a `next_cursor` field which is null on the final page; clients should
loop until it is null rather than counting pages.

## Errors

Errors return a machine-readable `code`, a human-readable `message`, and where
applicable a `field` naming what was wrong. The `code` is stable and safe to
branch on; the `message` is for humans and may change without notice.

Use the status code that describes the situation. A request that is well-formed
but semantically invalid is a 422, not a 400. A request for a resource the caller
is not allowed to see returns 404 rather than 403, so that the existence of the
resource is not leaked.

## Idempotency

Every mutating endpoint accepts an `Idempotency-Key` header. Keys are retained
for twenty-four hours, and a repeated request with the same key returns the
original response rather than performing the action again.

This is not optional for anything touching Ledger. Network retries are ordinary,
and a transfer executed twice is the worst class of bug Harbour can produce.

## Rate limits

Rate limit state is returned on every response in the `X-RateLimit-Remaining` and
`X-RateLimit-Reset` headers. A client that waits for a 429 before slowing down is
doing it wrong; back off as remaining approaches zero.

A 429 response includes a `Retry-After` header in seconds. Clients must respect
it, and clients that retry immediately are throttled more aggressively.
