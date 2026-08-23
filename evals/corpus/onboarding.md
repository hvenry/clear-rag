# Engineer Onboarding

Your first week is deliberately unstructured. The goal is a merged pull request
by Friday, however small.

## Machine setup

Run the bootstrap script on your first morning:

    hb bootstrap

It installs the toolchain, provisions your development database, and requests
the access grants you will need. Bootstrap takes about forty minutes and is
safe to re-run if it fails partway through.

You will need a Yubikey before bootstrap can finish; ask your manager if one was
not waiting on your desk. Access to production is not granted during onboarding
and is deliberately gated behind three months of tenure.

## Your mentor

Every new engineer is paired with a mentor for their first month. The mentor is
never the new engineer's manager, so that asking a naive question carries no
performance implication. Expect a daily fifteen minute check-in for the first
two weeks, dropping to twice weekly after that.

## First contribution

Pick something from the `good first issue` label. Your mentor will review it.
Aim to open the pull request small enough that review takes under twenty
minutes — a hundred changed lines is a reasonable ceiling for a first change.

Continuous integration must be green before review, not after. Reviewers will
not look at a pull request with failing checks, and this is not considered rude.

## How we work

Written communication is asynchronous by default. Nobody is expected to answer
a message outside their working hours, and there is no expectation of a response
within any particular window unless the message is a page.

Meetings require an agenda circulated beforehand. A meeting without one can be
declined without explanation, and doing so is not considered impolite.
