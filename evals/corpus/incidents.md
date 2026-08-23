# Incident Response

## Severity levels

**SEV1** means Harbour is unavailable to a majority of tenants, or money is at
risk of being lost or double-counted. A SEV1 pages the on-call engineer
immediately and the platform lead within five minutes.

**SEV2** means a significant feature is broken or badly degraded but the
platform is broadly usable, and no financial correctness is at stake. SEV2 pages
the on-call engineer during working hours and creates a ticket outside them.

**SEV3** covers everything else worth tracking — cosmetic defects, slow queries
that are not yet user-visible, and near-misses. SEV3 never pages anyone.

## On-call

The rotation is weekly and hands over at 10:00 on Wednesday. Handover is a live
conversation, not a written summary; the outgoing engineer walks the incoming
one through anything still open. Being on call is compensated with a day off in
lieu, taken within the following month.

The on-call engineer is expected to acknowledge a page within ten minutes. If a
page is not acknowledged it escalates to the platform lead, and after a further
ten minutes to the head of engineering.

## During an incident

One person is the incident commander and does not debug. Their job is to keep a
running timeline, decide when to escalate, and communicate status every thirty
minutes even when there is nothing new to report. Silence is read as absence.

Mitigate before you diagnose. Restoring service takes priority over
understanding why it broke, and the most common mitigation is reverting the most
recent release.

## Afterwards

Every SEV1 and SEV2 gets a written postmortem within five business days. The
postmortem is blameless: it describes what the system did and what information
people had at the time, never what an individual should have done differently.

Each postmortem produces action items with named owners and due dates. Action
items without an owner are not action items, and a postmortem is not considered
complete until every item has one.
