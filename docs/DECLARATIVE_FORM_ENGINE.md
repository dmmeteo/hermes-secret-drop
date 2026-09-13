# The declarative form engine — accepted product canon

**Status: accepted.** This supersedes the preset framing for inbound Drop forms. Work on
the inbound form follows the architecture below; a change that reintroduces per-use-case
presets is a change to this document first.

## The decision

Drop is a **constrained declarative form engine**, not a growing set of
login/API-key/files presets.

A requester composes an **ordered combination of fields**, each with a stable id, a
concrete label and one of five standard types. Drop renders them, validates them,
encrypts them in the browser, and delivers the values keyed by those ids.

The difference matters because presets do not compose. "Login" and "API key" and "files"
are three screens, and the fourth request — a release tag and two independent groups of
logs — needs a fourth. Fields compose: every shape the product needs is some combination
of five types, which is why the type set is small and why it is closed.

**A new type is added only when no combination of the existing ones expresses the
request.** That is the whole admission rule, and it is what keeps this from becoming a
preset list with extra steps.

## The three contracts, kept orthogonal

Carried forward from the vault analysis, and still the frame:

1. **Input schema / presentation** — what is asked for and how it is drawn.
2. **Consumer / execution binding** — where the values go.
3. **Retention / source of truth** — what, if anything, keeps them.

**Form type must not determine storage or authorization.** The engine decides (1). It
decides (2) only in the narrow sense that a `secret` field forces the no-model consumer
lane. It decides nothing about (3), and no part of it may grow a destination field.

## What the engine is

| | |
|---|---|
| Contract | `{ version, title?, description?, fields[] }`, ≤ 8 fields, bounded, closed key sets |
| Field | `{ id, type, label, required?, min_files?, max_files? }` |
| Types | `text`, `email`, `textarea`, `secret`, `files` |
| Identity | the **id** — unique, `^[a-z][a-z0-9_]{0,31}$`. The **label** is display data and need not be unique |
| Wire | `payload_kind: "form"`, envelope v3, HDROP3 container |
| Binding | `info` binds SHA-256 of the canonical contract **and its derived delivery block** |
| Implementations | `src/form-contract.js` (authority) and `drop/form_contract.py` (refuses before minting), one shared case table |

Full schema, bounds and refusal vocabulary: `contract/control-protocol.json`,
`form_contract`.

## The rules that are load-bearing

**Delivery is derived, never chosen.** `consumer` if any field is `secret`, `model`
otherwise. There is no argument anywhere that selects a result type, so no argument can
downgrade masking by asking for a public one. The derived delivery block is part of the
canonical contract and therefore part of the digest bound into the AEAD.

**The contract is bound into the ciphertext.** The page seals under the contract it was
served; the broker opens under the contract it stored. A descriptor altered between them
produces a ciphertext that does not open. This binds *agreement between two stored
values* — it does not authenticate the JavaScript the server sent, and it does not
identify the submitter. Neither is claimed.

**Values are an ordered array, never an object keyed by a field id** — on the wire, in
the manifest, through the broker, into the consumer. A hostile id has nowhere to land.
The id grammar is the second, independent defence.

**The broker is the authority on submitted values**, and it is a real one: it holds the
private key, so the moment after the AEAD opens is the first moment plaintext exists. The
page runs the same rules from the same module, which makes its copy a courtesy to the
sender and evidence of nothing. A refused submission consumes nothing.

**Nothing is silently repaired.** A contract that breaks a rule is refused with a code.
Whitespace inside a *submitted value* is preserved byte for byte — a password of three
spaces is three spaces — and the only thing whitespace decides is whether a required
field counts as blank.

**An all-optional form is legal.** What an empty submission means is defined at submit
time instead. A form of optional questions is a real request, and refusing to build one
would be the engine deciding for the requester what a reasonable request looks like.

**Language.** All chrome, titles and labels are English. `description` is the one element
in the requester's language. Nothing detects or enforces that — a detector would refuse
copy it misread.

## The consumer boundary

A form containing any `secret` field is bound at mint to a named consumer, and the
**whole** submission — secret values, ordinary values and files alike — is delivered to
it in one call. The model receives a receipt with no values in it. Nothing splits the
bundle per field, because a per-field decision about where a value may go is a per-field
mistake waiting to happen.

**It ships closed.** `drop/consumers.py` registers nothing, so a secret form is refused
**at mint** with `secret_consumer_unavailable` — before a link is posted, before a drop
exists, before anyone is asked to type a password Drop could not honestly receive. The
model-facing schema says so. The canary consumer lives in the test suite and is never
registered; **it is not vault, BWS or `.env` integration.**

**The receipt is a construction, not a filter.** A consumer returns a `ConsumerStatus`
member and nothing else; the receipt is built from the validated contract and the
delivery record. Scanning a receipt for substrings of the submitted values was considered
and rejected: any encoding defeats it, and a two-character username would make half the
alphabet unreturnable.

**Honest scope.** This prevents a value being returned to the model *by accident*. It is
**not** protection against a malicious host-side plugin, which runs as the host user and
need not return anything to exfiltrate.

**Exactly-once is not claimed.** Drop is one-shot, so a consumer is called at most once
per drop — but "called once" is not "took effect once" for a sink whose own write is not
idempotent. `delivery_token` is stable and derived so an idempotent sink can key on it; a
sink that cannot is at-least-once, and says so.

## What a future authorized sink must do

Implement `SecretConsumer` (`name`, `accepts`, `deliver`), and be added to the closed
registry in a reviewed change. It must not be resolvable from a dotted path, an entry
point, a model argument or a shell command — that is the "opaque external executor"
`NEXT_ITERATION_SECURITY_TASKS.md` lists as out of scope, and the registry is closed
precisely so the door stays shut.

The destination must be resolved by trusted code from an approved registry and authorized
by an identified user. A model may **propose** a resource; it may never name one.

## Compatibility

The reviewed adaptive descriptor (`mode`, `label`, `description`, `expect_files`) still
works and is still validated by `src/form-request.js`. It is the alternative to `form`,
never a companion: sending both is refused as `form_and_legacy_descriptor` rather than
resolved by precedence. Legacy no-form, `text`, `files` and `universal` callers are
unchanged, and `form_protocol` advertises 2 while the descriptor's own floor stays 1.

## Deliberately not in this engine

- Any destination field, at any depth, under any name.
- Model-generated validation, arbitrary HTML or JS, or JSON Schema evaluation.
- A production secret sink of any kind.
- `secret` values reaching a tool result, a log, a notice, the journal or durable session
  state.
