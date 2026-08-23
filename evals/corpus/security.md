# Security Practices

## Access control

Access to Harbour systems is granted by group membership, never to individuals.
If you find yourself adding a person directly to a resource, that is a signal the
group model is wrong and should be raised with the platform team rather than
worked around.

Production database access requires a break-glass request. The request names a
reason and an expected duration, is approved by any two engineers who are not
the requester, and expires automatically after four hours regardless of whether
the work finished. Break-glass sessions are recorded in full and reviewed weekly.

Read access to production logs does not require break-glass, but logs are
scrubbed of personally identifiable information at write time, so they are less
useful for debugging customer-specific problems than people expect.

## Secrets

Secrets live in Vault and are injected as environment variables at process
start. Nothing secret is ever committed to a repository, including in test
fixtures, and the pre-commit hook will reject a commit containing anything that
matches a credential pattern.

If a secret is committed anyway, treat it as compromised even if the commit was
never pushed. Rotate first and investigate afterwards. Rewriting history is not
a substitute for rotation, because the value may already have been read.

Secret rotation is quarterly for service credentials and immediate for anything
involved in an incident. Rotation is automated for database passwords and
manual for third-party API keys, which is a known gap.

## Dependencies

Dependency updates land through automated pull requests, batched weekly for
patch versions and raised individually for minor and major ones. A dependency
with a known critical vulnerability is patched within seventy-two hours,
including if that means shipping on a Friday.

New dependencies require a brief justification in the pull request description:
what it does, why writing it ourselves is worse, and how actively it is
maintained. Adding a dependency for a function you could write in twenty lines
is usually the wrong call.

## Reporting a vulnerability

Internal reports go to the security channel. External reports arrive through
security@ and are acknowledged within one business day. Harbour does not
currently run a paid bug bounty, though it does maintain a public
acknowledgements page.

Never test a suspected vulnerability against production tenants. Reproduce it in
staging, which holds scrubbed data specifically so this is possible.
