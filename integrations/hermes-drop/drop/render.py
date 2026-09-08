"""The rendering matrix. Two tiers, one table, no fallbacks.

This table is the **only** place a platform's support tier lives. Splitting it
would let a refusal and a renderer disagree, and the way that disagreement
resolves in practice is "post it somewhere that works" — which is the incident.

* ``verified`` — Discord and Telegram. The broker renders their notices natively
  (``src/notice.js``), and their adapters implement ``edit_message`` with the
  signature the messenger actually calls.

  "Natively" means one thing on both rows: a ``> `` blockquote **card**. That is
  the one rich construct reachable through the plugin-facing adapter interface —
  Telegram's ``format_message`` converts a leading ``>`` into a real MarkdownV2
  blockquote and Discord renders it as a blockquote client-side, on the send path
  and on the ``finalize=True`` edit path alike. No core change and no capability
  is needed for it.

  What is **not** reachable is a Discord embed, and therefore no per-state accent
  colour. ``DiscordAdapter.send`` posts ``channel.send(content=…)`` and its
  ``edit_message`` posts ``msg.edit(content=…)``; the adapter contract types the
  payload as ``content: str`` (``gateway/platforms/base.py:2399``, ``:2412``) and
  Discord reads only ``thread_id``/``notify`` out of ``metadata``. The adapter's
  own embeds live in private fixed-shape prompt builders that attach a
  ``discord.ui.View`` and have no embed-carrying *edit* counterpart, so an embed
  could not survive a lifecycle transition even if one could be sent. The state
  signal is therefore the glyph and the label, not a colour. A canary test reads
  the real adapter's source and fails if that ever changes:
  ``tests/test_notice_adapter_seam.py::test_a_discord_notice_is_a_markdown_quote_and_not_an_embed``.
* ``unsupported`` — everything else. Refused **before** anything is minted, with
  ``{"error": "platform_unsupported", "platform": "<p>"}`` naming the platform.
  Never a silent fallback to ``plain``; never a redirect to a platform that *is*
  supported.

Revision 1's third tier, ``expected`` ("any adapter implementing
``edit_message``"), is cut. It promised an ``edit_message`` call carrying
``metadata``, which is a ``TypeError`` on six of nine adapters, and Slack needs an
operator manifest update besides — slash commands are only emitted into a
*manifest fragment* (``hermes_cli/commands.py:1355-1380``).

``e2e_evidence`` is ``None`` for both supported platforms and stays ``None`` until
slice S11/M7 records a real run in ``E2E-EVIDENCE.md``. ``verified`` is the tier
the plan assigns; it is not a claim that a live platform accepted an edit. The CI
stand-in is the stub adapter: full path coverage, zero network, and no proof a
real platform accepted anything.
"""

from __future__ import annotations

from typing import Any, Dict, List

VERIFIED = "verified"
UNSUPPORTED = "unsupported"

#: Exactly two. A third tier is how "unsupported" quietly becomes "probably fine".
TIERS = (VERIFIED, UNSUPPORTED)

#: ``plain`` is a real broker renderer (S1) — a bare URL on its own line with an
#: absolute UTC deadline. It exists so an unsupported platform's *refusal* can be
#: honest about what it would have rendered, not so Drop can post there anyway.
PLAIN_RENDERER = "plain"

TABLE: Dict[str, Dict[str, Any]] = {
    # Blockquote card; masked Markdown link, no embed (none is reachable — see the
    # module docstring), so the capability stays in the #fragment. Deadline via
    # <t:UNIX:R>, client-rendered, zero API calls. `format_message` returns the
    # card byte-identical, so Discord draws the quote block from the content.
    "discord": {"renderer": "discord", "tier": VERIFIED, "e2e_evidence": None},
    # Blockquote card too, converted to a native MarkdownV2 blockquote by
    # `format_message` step 9 (`adapter.py:4959-4966`). The *expandable* form
    # (`**>` … `||`) is deliberately unused: step 5's bold conversion runs first
    # and eats the `**` prefix, and the `||` terminator only closes on one line.
    # Masked Markdown link too — `format_message` translates it into a MarkdownV2
    # link, and the HTML this used to emit was escaped and *displayed*, capability
    # and all (review H1). Absolute UTC deadline, since Telegram re-renders
    # nothing. The link preview is **not** suppressed: `_link_preview_kwargs`
    # reads the adapter's own `_disable_link_previews` config
    # (`plugins/platforms/telegram/adapter.py:1495-1500`) and no `metadata` key
    # overrides it per message, so Drop cannot turn it off from here. Harmless as
    # it stands — a URL fragment is never sent to the server, so an unfurler
    # fetches the bare base URL and the capability is not in what it retrieves.
    "telegram": {"renderer": "telegram", "tier": VERIFIED, "e2e_evidence": None},
}

_UNSUPPORTED_ENTRY: Dict[str, Any] = {
    "renderer": PLAIN_RENDERER,
    "tier": UNSUPPORTED,
    "e2e_evidence": None,
}


def _platform_name(platform: Any) -> str:
    value = getattr(platform, "value", platform)
    return str(value or "").strip().lower()


def entry_for(platform: Any) -> Dict[str, Any]:
    """The table row for *platform*. Unknown platforms are ``unsupported``.

    Defaulting an unrecognised platform to ``unsupported`` rather than raising
    means a platform Hermes gains tomorrow refuses instead of guessing, and it
    refuses with a message naming itself.
    """
    return dict(TABLE.get(_platform_name(platform), _UNSUPPORTED_ENTRY))


def is_supported(platform: Any) -> bool:
    return entry_for(platform)["tier"] == VERIFIED


def renderer_for(platform: Any) -> str:
    """The ``notice_platform`` value to send the broker. Only meaningful for a
    supported platform; callers must gate on :func:`is_supported` first."""
    return entry_for(platform)["renderer"]


def supported_platforms() -> List[str]:
    return [name for name, entry in TABLE.items() if entry["tier"] == VERIFIED]


def unsupported_error(platform: Any) -> Dict[str, str]:
    return {"error": "platform_unsupported", "platform": _platform_name(platform)}


__all__ = [
    "PLAIN_RENDERER",
    "TABLE",
    "TIERS",
    "UNSUPPORTED",
    "VERIFIED",
    "entry_for",
    "is_supported",
    "renderer_for",
    "supported_platforms",
    "unsupported_error",
]
