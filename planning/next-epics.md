# Next epics

The only outcome checklist for this repository. Statuses describe this public `main` revision (plugin 0.6.0, broker 0.5.0). Implemented code is not runtime verification or user acceptance. An item is checked only after its completion condition is verified. Candidates are not selected and are not permission to implement.

## Delivered baseline

This revision implements what [README.md](../README.md) describes: origin-bound inbound text and file drops through the Node broker, outbound values, declarative forms and durable sanitization of claimed secrets. The security MVP list in [NEXT_ITERATION_SECURITY_TASKS.md](../NEXT_ITERATION_SECURITY_TASKS.md) is retained for its history and its out-of-scope list. Its lifecycle and restart-recovery work landed in commit `505f025`, and control protocol 2 added the pre-consumption size check. Open security limits live in [SECURITY.md](../SECURITY.md#known-limitations-tracked-rather-than-fixed). This pass recorded no new runtime or user acceptance.

## Outcomes

- [ ] **The outbound reveal page is verified in a live browser.**
  - Status: open. SECURITY.md lists it as a deployment smoke-test obligation. Browser-style integration tests cover the reveal flow.
  - Done when: a real browser on the production HTTPS origin reveals an outbound value with the code, copies it with the clipboard permission, and the claim and acknowledgement retry correctly under real network latency.
  - Fails if: the reveal works only in the test harness, or a retry consumes the value without showing it.
  - Reference: [SECURITY.md](../SECURITY.md#known-limitations-tracked-rather-than-fixed).
- [ ] **Pending drops survive a broker restart, and a delivered claim is always recorded.**
  - Status: not in this revision, where both are documented limitations. The maintainer has an unpublished SQLite store release that addresses them. Publishing it needs explicit owner authorization and is not selected by this checklist.
  - Done when: after a backend restart, a pending link still accepts a submission and a submitted payload is still claimable, and a claim is retired only after the receiver holds a verified copy.
  - Fails if: a restart loses an accepted payload, or a claim is consumed without a record.
  - Reference: [Limitations](../README.md#limitations).
- [ ] **Candidate, not selected: automated coverage of adapter `send` and `edit_message`.**
  - Status: unselected. Both calls need live platform credentials and are exercised only by manual end-to-end runs.
  - Done when: an owner-approved test drives both calls against a real adapter without exposing credentials.
  - Fails if: a test needs real credentials in the repository or in CI logs.
  - Reference: [SECURITY.md](../SECURITY.md#known-limitations-tracked-rather-than-fixed).
