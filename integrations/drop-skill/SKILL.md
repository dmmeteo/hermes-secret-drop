---
name: drop
description: "Move a private value in this conversation without typing it in chat: ask the user for one through a one-shot encrypted form, or hand one back through a one-time reveal link."
version: 1.0.0
author: dmmeteo
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [secrets, security, credentials, handoff, privacy]
    category: security
---

# Drop

The user invoked `/drop`. A secret has to move, and it must not move through
the chat. Decide the **direction**, then call exactly one Drop tool.

There is no other form of this command. `/drop` takes a prompt or nothing —
never a duration, never a destination, never a secret value.

## Decide the direction

Read what the user typed after `/drop`:

| What they typed | Direction | Tool |
|---|---|---|
| nothing at all | **inbound** — they want to hand you something | `request_private_input` |
| they have a value for you ("here's my API key", "I'll paste the token") | **inbound** | `request_private_input` |
| they want a value from you ("give me the DB password", "generate an admin key and send it to me") | **outbound** | `send_private_output` |
| you cannot tell | ask **one** short question; if they do not answer, treat it as **inbound** | `request_private_input` |

Direction follows meaning, not whether an argument is present. `/drop the
staging token` is inbound — the user is naming what they are about to give you.
`/drop me the staging token` is outbound.

Inbound is the safer fallback: the worst case is a form the user ignores, and
it expires on its own. Guessing outbound when the user meant inbound would
reveal something nobody asked for.

## Inbound — the user gives you a value

Call `request_private_input` with a short, non-secret `purpose` (a label for
the audit journal, e.g. `deploy token`, `staging DB password`). That posts a
one-shot encrypted form into **this** conversation and returns immediately.

### Say what you are asking for

The form is a web page the user opens on their own. By default it shows a text
box **and** a file picker and lets them choose — which is right when you do not
know what they are about to send, and unhelpful when you do.

Four optional arguments make it specific. Use them **only for what you already
know from the conversation**:

| Argument | Use it when | Example |
|---|---|---|
| `description` | almost always — one short sentence telling the user what to paste or upload | `Paste the staging deploy token from 1Password.` |
| `label` | a heading would help them recognise the request | `Staging deploy token` |
| `mode` | you know it is text (`text`) or files (`files`) | `files` |
| `expect_files` | they named a number, with `mode: files` | `2`, for "both config files" |

**Omit anything you are guessing at.** A wrong `mode` takes a lane away from
the user: `mode: text` means they cannot attach the file they meant to send.
No `mode` is the universal form, which always works — it is the fallback, not
a failure.

Write `description` in the language of the conversation. It is plain text, one
line, and the user reads it next to an input they are about to paste a
credential into, so: no secrets in it, no URLs, no markup, and nothing that
pressures them. Say what you need and stop.

Then stop and wait. You are notified when the form is used; that notification
carries a `drop_id`. Only then call `claim_private_input` with it. One claim
only — the payload is destroyed after.

The claimed value is yours to use, not to repeat. Never echo it, never
summarize it, never quote it back "to confirm", never write it into a file the
user did not ask for, and never pass it to a tool that logs its arguments.

## Outbound — you give the user a value

Call `send_private_output` with one labelled field per value. That posts a link
and a short code into this conversation; the page shows each value with its own
Copy button and keeps `secret` fields hidden until the user asks.

**Prefer `generate` over inventing the value yourself.** For a new password or
key, send `generate` instead of `value`: the service creates it, so the
plaintext never enters this conversation, this turn, or the session transcript.
Only supply `value` for a secret that already exists and that you were given.

After it is sent, the values are gone from your side of the conversation. Do
not repeat them in chat, not even partially.

## Rules that do not bend

- **Never ask for a secret in plain chat**, and never accept one there. If the
  user pasted a secret into the `/drop` prompt itself, do not repeat it, do not
  act on it as a credential, and tell them it may already be in the transcript
  and should be rotated — then use `request_private_input` for the replacement.
- **You cannot choose where a link goes.** It always goes to the conversation
  you are in. No tool here takes a platform, channel, chat or user id, and
  there is nothing for you to pick.
- **A refusal is a refusal.** If a tool returns an error, report what happened
  in one sentence and stop. Do not retry on another platform, do not fall back
  to asking in chat, and do not invent a link.
- **One `/drop`, one drop.** Do not mint a second form or a second reveal link
  in the same turn unless the user asked for two distinct values.
