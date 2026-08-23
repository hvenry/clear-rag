# Observability

Three signals, with different costs and different jobs. Reach for them in this
order: metrics to notice, traces to localise, logs to understand.

## Metrics

Metrics are Prometheus-format and scraped every fifteen seconds. Retention is
thirteen months at full resolution, which is deliberately long enough to compare
a quarter against the same quarter last year.

Every service exports the four golden signals: latency, traffic, errors, and
saturation. Latency is reported as a histogram, never as an average — an average
latency figure hides exactly the tail you care about, and Harbour dashboards
show p50, p95 and p99 rather than a mean.

Cardinality is the thing that will bite you. Never label a metric with a tenant
id, a request id, or anything else unbounded; the rule of thumb is that a label
should have fewer than a hundred distinct values over the life of the service.

## Tracing

Traces are sampled at one percent by default, with a header that forces sampling
for a specific request when you are actively debugging. Every service propagates
the trace context, and a service that drops it will show up as a broken trace
rather than a missing one.

Spans should be named for the operation, not the function. `ledger.transfer` is
useful; `handlePost` is not.

## Logging

Logs are structured JSON. A log line without a trace id is nearly useless during
an incident because it cannot be correlated with anything else, so the logging
helper attaches one automatically and you should not construct log lines by hand.

Log volume is billed, and log levels are enforced in review. Debug logging in a
hot path is the single most common cause of a surprise observability bill.
Anything logged at info level in a request handler will be emitted millions of
times a day.

## Dashboards and alerts

Every service has one dashboard that fits on a single screen. If it does not fit,
the fix is to remove panels, not to add a second dashboard nobody opens.

Alerts fire on symptoms, not causes. "Checkout error rate above two percent" is
a good alert because it describes something a user experiences; "CPU above
eighty percent" is a bad alert because high CPU is not by itself a problem.

An alert that has fired more than three times in a month without anyone acting
on it is deleted. An alert nobody acts on trains people to ignore the ones that
matter.
