# Fonts

Self-hosted, served by the broker from its own origin (`/assets/fonts/…`, see
`src/public-server.js`). The page makes no third-party font request.

| File | Family / weight | Version | Licence | sha256 |
|---|---|---|---|---|
| `FixelDisplay-Medium.woff2` | Fixel Display 500 | 1.0 | SIL OFL 1.1 — `OFL-Fixel.txt` | `5d997420…87ac0` |
| `FixelText-Regular.woff2` | Fixel Text 400 | 1.0 | SIL OFL 1.1 — `OFL-Fixel.txt` | `381f81ab…7bb26` |
| `GeistMono-Regular-latin.woff2` | Geist Mono 400 | 1.701 | SIL OFL 1.1 — `OFL-Geist.txt` | `3f98383b…9b5` |

- **Fixel** © 2023 MacPaw Way Ltd. — <https://github.com/MacPaw/Fixel>
- **Geist Mono** © 2024 The Geist Project Authors — <https://github.com/vercel/geist-font>

These are the same files, byte for byte, as the ones packaged with the Hermes AI Limits
widget (`hermes-widgets`, `ai_limits/assets/fonts/`), and they are not modified here.

Coverage, as shipped:

- Both Fixel files are subset to Latin-1 plus Cyrillic, including the whole Ukrainian
  alphabet (Ґґ Єє Іі Її Йй), so a requester's description in Ukrainian renders in Fixel.
- The Geist Mono cut is **Latin only**. Mono is used for the page's English chrome,
  field labels, the code input and values. A value typed or revealed in Cyrillic falls
  back to the system `ui-monospace` for those characters.
