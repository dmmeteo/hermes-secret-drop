# Hermes Secret Drop — page design

The design record for the browser page (`src/public/`). It records the decisions, the
constraints they must respect, and how to check them. Earlier explorations, a
quiet-technical direction and a chromatic editorial one, were superseded by **Aperture**;
only their functional constraints were carried forward, and those are listed below.

## The page

A short-lived utility opened from a conversation. A person either supplies values or files
that were asked for, or deliberately reveals values once. It is not a dashboard, a vault or
a landing page.

Most drops are opened on a phone, so the narrow layout is the primary design and the wide
layout is the enhancement.

## Aperture

- **Motif.** A one-time passage: interrupted contour rings with a single lime path through
  them.
  - Below 960px the motif is a background behind the status row and the title: 0.23
    opacity, a 1.6px blur, a fade mask, and clipped by the shell. It is never a banner or a
    block a person scrolls past.
  - At 960px and wider it is the left column, with the caption "Not another message. / A
    way through.". It is sticky, so on a long screen it stays centred in the window while
    the column beside it scrolls.
  - Every control is drawn on an opaque surface above it.
  - It is one inert inline SVG. See the security constraints.
- **Material and type.** Ink-violet canvas and surfaces with a lime action. Faces:
  - Fixel Display 500 for headings and the action.
  - Fixel Text 400 for prose and interface text.
  - Geist Mono 400 for the page's own annotations: status rows, labels, meta, the code box
    and values.
- **Shared anatomy on every screen.**
  1. Identity row: "Hermes Secret Drop", a CSS-drawn mark, and the tagline "A private
     passage".
  2. Status row, with the clock where one applies.
  3. The heading and one supporting line.
  4. The controls, in canonical order.
  5. A consequence line immediately above the one action.
  6. "About this drop", collapsed.
- **Primary action.** A 54px pill. The label is centred on the *whole* button, and the arrow
  is pinned on its own near the right edge, rather than the label and arrow being centred
  together as a group. The arrow is generated content with empty alternative text, so the
  button's accessible name is exactly its label ("Send", "Sending…", "Reveal once").
- **Themes.** The page follows the device through `prefers-color-scheme`, and each role is
  mapped separately per theme.
  - Dark is the reference palette.
  - Light keeps the lime as a *fill*, turns it olive `#4a6300` wherever it would be text,
    and uses violet `#6a45c2` for focus.
- **Absent on purpose.** Retro window chrome, hard offset shadows, poster layouts, gradient
  buttons and animation. The only motion is short colour and transform transitions, and
  `prefers-reduced-motion` removes them.

### Screens

- **Inbound.**
  - Text.
  - Universal: text and files together, no tabs, either lane or both.
  - Files: an exact count when one is requested, rows with name, size and Remove, and a
    tally.
  - Declarative forms: fields in contract order. A secret field has Show/Hide inside its
    reserved right edge, so the control never covers the end of a value.
- **Outbound.**
  - The gate: one code box, the attempts note, the one-reveal consequence and "Reveal
    once". How the drop is protected is in its "About this drop".
  - A wrong code is refused beside the field.
  - Revealed values: one row per field, mono values, masked secrets, and Show/Hide separate
    from Copy. A persistent spent-link warning is shown and there is no clock.
- **Terminal and transient.** Received; unavailable, which also covers expired; and a
  loading line shown only while `#app[data-state="loading"]`. A failed link check has
  its own connection-problem screen with an explicit Retry. It uses the shared status,
  consequence, action and disclosure anatomy; Retry stays focusable while checking.
  Network failures, a 20-second deadline (including body reads), malformed JSON and
  temporary HTTP failures (408, 429, 5xx) reach this screen. Definitive refusals and
  unsupported metadata still reach the generic unavailable screen. Retry requests
  metadata on the same link only; it preserves expiry and wrong-code budgets.

### Intentional differences from the design studies

The studies were static mock-ups: a desktop code gate, phone renders of a token request, a
login request and an SSH-key request, and a side-by-side comparison of left-aligned and
centred button labels, in which the centred variant was chosen. They were evidence for the
look, not contracts.

| In the studies | Shipped | Why |
|---|---|---|
| Buttons "Send privately", "Open once" | "Send", "Reveal once" | The existing labels are pinned by tests, and "Send privately" is already the universal heading |
| Study chrome: a footer, a study number, "Static preview", "01 / The opening" | Not shipped | It describes the mock-up, not the product |
| Hints tailored to each example ("including its prefix", an SSH-key hint) | Not shipped | The form contract has no hint field, and adding one would be a preset |
| Dark only | Dark plus a light theme mapped separately | The page's existing device light/dark support is preserved |
| Tagline 10px | 8px below 960px, hidden below 361px | It fits on one line with the longer product name |
| Fixed heading sizes | `clamp(28px, 11vw, 51px)` | The same sizes at phone and desktop widths; the low floor only matters under zoom, where it stops long words from being split |
| The gate said "only this browser can open" and "nothing is tracked or logged" | Removed | Both overclaim: before a claim, anyone with the link and the code can open the drop, and the broker keeps an access log of method, path and status. A test keeps both out |

## Functional constraints

These are load-bearing, and each is covered by a test.

- **Language and rewritable copy.**
  - Every built-in string is English, and so is a requester's `label`.
  - `request-description` is the only element whose language is the requester's choice.
  - Requester copy reaches the page only as `textContent`, in the two rewritable elements.
  - The identity row, the status row with its clock, the consequence line and the
    disclosure are static, and sit outside those two elements.
- **No destination controls**, no presets and no wizard.
- **Inbound.**
  - Fields follow the contract's order.
  - Five field types: text, email, secret, textarea and files.
  - The legacy text, files and universal modes are unchanged.
  - Exact file counts and file budgets are enforced. The page's checks are a convenience
    only, because the broker re-checks everything.
  - Submissions are byte-preserving, and Send cannot be activated twice while a
    submission is in flight.
- **Secret-containing declarative forms** require an authorised host-side consumer, and none
  ships. A login/password form is conditional design and is not presented as available.
- **Outbound gate and reveal.**
  - One input takes the whole code, with a numeric keyboard, paste and Enter.
  - The attempt count comes from the service.
  - The code is an anti-preview gate, not authentication.
  - There is one claim id per page, and the acknowledgement is sent only after local
    decryption.
  - Nothing is auto-revealed, there is no bulk copy, and reload recovery is never promised.
  - The consequences of revealing — one reveal, a spent link, the expiry — stay on screen
    above the action. The encryption and code mechanics may live in the disclosure
    (`docs/OUTBOUND_SECRET_DROP_MVP.md`).
- **Received** confirms receipt only, never what happens downstream.
- **Unavailable** is one generic screen for expired, used, unknown and refused, and it never
  requests a replacement link automatically.
- **Page security.**
  - No inline script or style.
  - Exactly one inline, `aria-hidden`, non-focusable SVG, outside every screen. It holds no
    links, references or scripts.
  - No third-party request.
  - The CSP, pinned whole by a test:
    `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self';
    img-src 'none'; font-src 'self'; base-uri 'none'; form-action 'none';
    frame-ancestors 'none'`. Same-origin fonts are the only widening; `img-src` stays
    shut, which is why the art is inline markup.

## Fonts

| Face | File (`src/public/fonts/`) | Licence | Coverage |
|---|---|---|---|
| Fixel Display 500 | `FixelDisplay-Medium.woff2` | SIL OFL 1.1, `OFL-Fixel.txt` | Latin-1 and the complete Ukrainian alphabet |
| Fixel Text 400 | `FixelText-Regular.woff2` | SIL OFL 1.1, `OFL-Fixel.txt` | Latin-1 and the complete Ukrainian alphabet |
| Geist Mono 400 | `GeistMono-Regular-latin.woff2` | SIL OFL 1.1, `OFL-Geist.txt` | Latin only |

- They are served from three explicit same-origin routes with `font-display: swap`.
- Provenance and checksums are in `src/public/fonts/README.md`.

## Contrast

WCAG contrast ratios, computed from the token values.

| Pair | Light | Dark | Minimum |
|---|---|---|---|
| ink on canvas / surface | 14.73 / 16.33 | 14.33 / 12.95 | 4.5 |
| muted on canvas / surface | 7.92 / 8.79 | 8.83 / 7.98 | 4.5 |
| meta on canvas / surface | 6.33 / 7.02 | 6.40 / 5.78 | 4.5 |
| accent-as-text on canvas / surface | 6.06 / 6.72 | 12.86 / 11.62 | 4.5 |
| on-accent on accent / hover | 12.15 / 10.85 | 12.15 / 13.44 | 4.5 |
| control border on canvas / surface | 3.62 / 4.01 | 3.60 / 3.25 | 3.0 |
| focus on canvas / surface | 5.75 / 6.37 | 12.86 / 11.62 | 3.0 |
| selection | 12.86 | 12.86 | 4.5 |

Rules (1.41 light, 2.13 dark) are decorative and are never the only boundary of a control.

## How the design is checked

`npm run verify` covers the page's contracts: markup structure, the CSP, the font routes,
copy that may not regress, and the client wiring. It needs no browser.

Two real-browser runs drive headless Chrome against an in-process broker. They need a local
Chrome, so they are not part of `verify`:

```bash
npm run build
node scripts/form-screenshots.mjs --out <dir>   # inbound shapes, outbound, terminal states
node scripts/form-engine-e2e.mjs  --out <dir>   # declarative forms
node scripts/metadata-retry-e2e.mjs --out <dir> # link-check faults and metadata-only Retry
```

They render every screen at 1280×800 and at 390×844 in both themes, and assert:
- the action sits inside the first 390×844 screen for representative requests;
- nothing overflows, and no element crosses its screen's column, at 390px or at 200%
  zoom. The column check matters because the shell clips horizontal overflow, which a
  `scrollWidth` test cannot see;
- on a long wide screen, after scrolling, the art is still centred in the window;
- every self-hosted face loads under the shipped CSP;
- Tab reaches the action with a visible ring, and reduced motion removes every transition;
- the action's label is centred, and its accessible name is exactly the label;
- the loading, wrong-code, masked/shown reveal, received and unavailable states;
- byte-exact text and file round trips through the page's own crypto.

Visual acceptance needs a person to look at the renders. A green run is not visual
acceptance.

## Known limitations

- Mono text in Cyrillic, such as a value or a non-English label, falls back to the system
  `ui-monospace`, because the Geist Mono cut is Latin only.
- Form problems appear as one status line above the action, not beside each field.
- Browsers without the `content: … / ''` alternative-text syntax will announce the drawn
  arrow and the disclosure marker.
- The light palette was derived from the dark reference rather than from its own study.
