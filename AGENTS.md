# AGENTS.md

Cold-start map for agents working in this repository. [README.md](README.md) owns the product purpose, threat model and limitations. [SECURITY.md](SECURITY.md) owns the security policy, the lifecycle guarantees and the tracked known limitations. [planning/next-epics.md](planning/next-epics.md) is the only outcome checklist.

## Start and recover

1. Read this file.
2. Read the README [Threat model](README.md#threat-model) and [Limitations](README.md#limitations) before any change to a tool, the broker or the page.
3. Read [CONTRIBUTING.md](CONTRIBUTING.md#things-that-are-deliberate) before changing a deliberate behavior. Each one has a test that stops the change.
4. Read the selected outcome in `planning/next-epics.md`. Work on one selected outcome at a time.

After compaction or context loss, re-read this file, the threat model, the limitations and the selected outcome before the next consequential edit.

## Revision state

This is public `main`: plugin 0.6.0 and broker 0.5.0, both under `[Unreleased]` in [CHANGELOG.md](CHANGELOG.md). The broker is a Node.js service that keeps drops in memory and talks to the plugin over a 0600 Unix socket. The plugin lives in `integrations/hermes-drop/` and registers three tools. A later SQLite store and Python backend exist only in unpublished maintainer work. They are not part of this revision. Which revision a live gateway runs is not recorded here.

## Routes

| Task | Read |
|---|---|
| Plugin registration, hooks, the three tools | `integrations/hermes-drop/__init__.py` (`register`) |
| Origin resolution and refusal | `integrations/hermes-drop/drop/origin.py` (`resolve_origin`) |
| Broker state, single-use gates, HPKE open | `src/broker.js`, `src/main.js` |
| Public page server and API | `src/public-server.js` |
| Control socket and protocol | `src/control-server.js`, `integrations/hermes-drop/drop/control_client.py`, `contract/control-protocol.json` |
| Claimed-secret placeholder and request middleware | `integrations/hermes-drop/drop/vault.py` (`llm_request_middleware`), [Durable sanitization](README.md#durable-sanitization) |
| Outbound drops | [docs/OUTBOUND_SECRET_DROP_MVP.md](docs/OUTBOUND_SECRET_DROP_MVP.md), `integrations/hermes-drop/drop/outbound_payload.py` |
| Declarative forms | [docs/DECLARATIVE_FORM_ENGINE.md](docs/DECLARATIVE_FORM_ENGINE.md), `src/form-contract.js`, `integrations/hermes-drop/drop/form_contract.py` |
| Browser crypto and codecs | `src/hpke-suite.js`, `src/client/`, `test/` |
| Page design | [DESIGN.md](DESIGN.md) |

## Boundaries that must hold

- Origin binding. A drop posts only into the conversation that asked. No tool schema has a destination field, and resolution either verifies the origin or refuses. There is no fallback to a home channel, a default profile or `~/.hermes`.
- Confidentiality limits. This is not end-to-end encryption and is not independently audited. The broker host, the gateway and the model are trusted with the plaintext. Deletion is not hardened, and a broker restart destroys every pending drop. Keep these statements true in the README when behavior changes.
- The capability stays in the URL fragment. Plaintext never appears in a chat message, a request target, an access log, a `Referer` header or an HTTP response.
- The claimed plaintext reaches the provider request only through middleware. The persisted tool result carries a placeholder.
- Identifiers that installs or ciphertext depend on keep their spelling (`hermes-drop`, `hermes-drop/outbound/v1`).
- Nothing polls. The wake path is event driven.

## Authority

Owner approval is required to change a boundary above, a deliberate behavior in CONTRIBUTING.md, the threat model, product scope, or a checklist priority. A checklist item is not permission to implement it. Push, release, deployment and changes to live installs need explicit authorization.

## Done means

An outcome is complete only when its user-visible completion condition is verified on the real artifact. An implementation-only change does not tick an item. Passing tests or documentation checks are not runtime or user acceptance. Update `planning/next-epics.md` only for a verified outcome or an owner scope decision.

## Checks

`npm run verify` runs the broker build, tests and smoke run, then the plugin suite. Setup notes are in [CONTRIBUTING.md](CONTRIBUTING.md#getting-set-up).
