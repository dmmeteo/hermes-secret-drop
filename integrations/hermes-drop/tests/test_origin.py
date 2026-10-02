"""S4 — ``resolve_origin()``: the hard gate.

The first test in this file is the incident regression and it is the slice's
stop condition. Nothing else in the plan proceeds if it is red.

**The incident, mechanically.** A ``/drop`` typed in Telegram posted the
capability link into a Discord channel. The mechanism was the only generic send
the model had: ``_handle_send`` falls back to
``config.get_home_channel(platform)`` when no ``chat_id`` is given
(``tools/send_message_tool.py:446-465``), so ``send_message(target="discord", …)``
is a one-token instruction to post in the Discord home channel. Two things
sever it: no destination field in either schema (``test_schemas.py``), and an
adapter resolved from the *origin* rather than from configuration (here).

**Resolution order, refusing rather than defaulting** (plan §4):

1. ``_TURN_SOURCE`` — same-turn hit.
2. ``REGISTRY.by_routing_tuple(routing_tuple_from_context())``.
3. ``REGISTRY.by_session_key(HERMES_SESSION_KEY)``.
4. Nothing → ``no_origin``. Never reconstruct.

Then a **mandatory** verification against the bound contextvars on
``(platform, chat_id, thread_id, profile)``. This is not revision 1's deleted
cross-turn origin stamp, which compared two values derived from the same object
and was therefore unreachable. It is reachable, and the tests below reach it:
via ContextVar inheritance on an internal turn (where the capture hook never
runs, ``gateway/run.py:13633``) and via store staleness after a ``/new``,
compression rotation, or topic-recovery rewrite.
"""

from __future__ import annotations

import pytest
from gateway.config import GatewayConfig, HomeChannel, Platform, PlatformConfig

from _stubs import StubAdapter, StubRunner, bind_session_context
from conftest import load_plugin_package


@pytest.fixture
def plugin():
    return load_plugin_package()


@pytest.fixture
def sources(plugin):
    return plugin.drop.sources


@pytest.fixture
def origin_mod(plugin):
    return plugin.drop.origin


@pytest.fixture
def registry(sources):
    return sources.SourceRegistry()


@pytest.fixture
def bound():
    """Bind and unbind the session contextvars around one test."""
    from gateway.session_context import clear_session_vars

    tokens: list = []

    def _bind(**kwargs):
        tokens.extend(bind_session_context(**kwargs))
        return tokens

    yield _bind
    if tokens:
        clear_session_vars(tokens)


def make_event(source):
    class _Event:
        pass

    event = _Event()
    event.source = source
    return event


def discord_home_config(chat_id: str = "discord-home-channel") -> GatewayConfig:
    """A gateway config that *does* name a Discord home channel.

    The precondition matters: if no home channel were configured the incident
    could not have happened and the regression would prove nothing.
    """
    config = GatewayConfig()
    config.platforms[Platform.DISCORD] = PlatformConfig(
        enabled=True,
        home_channel=HomeChannel(platform=Platform.DISCORD, chat_id=chat_id, name="Home"),
    )
    return config


# ── THE INCIDENT REGRESSION — S4's stop condition ──────────────────────────


@pytest.mark.asyncio
async def test_telegram_origin_cannot_reach_the_configured_discord_home(
    sources, origin_mod, registry, bound
) -> None:
    telegram = StubAdapter(Platform.TELEGRAM)
    discord = StubAdapter(Platform.DISCORD)
    config = discord_home_config()
    runner = StubRunner({Platform.TELEGRAM: telegram, Platform.DISCORD: discord}, config=config)

    # Precondition: the home channel the incident used is configured and live.
    assert config.get_home_channel(Platform.DISCORD).chat_id == "discord-home-channel"

    source = telegram.build_source(
        chat_id="tg-private-chat", chat_type="dm", user_id="tg-user-1"
    )
    sources.capture(event=make_event(source), gateway=runner, registry=registry, session_key="s1")
    bound(platform="telegram", chat_id="tg-private-chat", session_key="s1")

    origin = origin_mod.resolve_origin(registry=registry, runner=runner)

    assert not isinstance(origin, dict), origin
    assert origin.adapter is telegram
    assert origin.source is source
    assert origin.source.chat_id == "tg-private-chat"

    # And a send through the resolved origin lands in the Telegram chat only.
    await origin.adapter.send(origin.source.chat_id, "capability-link-placeholder")

    assert [m.chat_id for m in telegram.sent] == ["tg-private-chat"]
    assert discord.sent == [], "a Telegram-origin drop reached Discord"
    assert all(m.chat_id != "discord-home-channel" for m in telegram.sent)


@pytest.mark.asyncio
async def test_discord_origin_outside_the_home_channel_stays_outside_it(
    sources, origin_mod, registry, bound
) -> None:
    """The mirror case: a Discord drop in a non-home channel must not be
    'helpfully' redirected to the configured home channel either."""
    discord = StubAdapter(Platform.DISCORD)
    config = discord_home_config()
    runner = StubRunner({Platform.DISCORD: discord}, config=config)

    source = discord.build_source(
        chat_id="some-other-channel", chat_type="channel", user_id="u", scope_id="guild-1"
    )
    sources.capture(event=make_event(source), gateway=runner, registry=registry, session_key="s2")
    bound(platform="discord", chat_id="some-other-channel", session_key="s2")

    origin = origin_mod.resolve_origin(registry=registry, runner=runner)
    await origin.adapter.send(origin.source.chat_id, "x")

    assert [m.chat_id for m in discord.sent] == ["some-other-channel"]


# ── resolution order ───────────────────────────────────────────────────────


def test_tier_one_is_the_same_turn_contextvar(sources, origin_mod, registry, bound) -> None:
    telegram = StubAdapter(Platform.TELEGRAM)
    runner = StubRunner({Platform.TELEGRAM: telegram})
    source = telegram.build_source(chat_id="c", chat_type="dm", user_id="u")

    sources.capture(event=make_event(source), registry=registry, session_key="s")
    bound(platform="telegram", chat_id="c", session_key="s")

    origin = origin_mod.resolve_origin(registry=registry, runner=runner)
    assert origin.source is source
    assert origin.tier == "turn_contextvar"


def test_tier_two_is_the_routing_tuple_when_the_contextvar_is_empty(
    sources, origin_mod, registry, bound
) -> None:
    """The wake-turn path: no capture ran this turn, but the store still holds a
    real source for this routing lane."""
    telegram = StubAdapter(Platform.TELEGRAM)
    runner = StubRunner({Platform.TELEGRAM: telegram})
    source = telegram.build_source(
        chat_id="c", chat_type="dm", user_id="u", thread_id="topic-3"
    )
    registry.put(source, session_key="s")

    bound(platform="telegram", chat_id="c", thread_id="topic-3", session_key="s")
    assert sources.turn_source() is None

    origin = origin_mod.resolve_origin(registry=registry, runner=runner)
    assert origin.source is source
    assert origin.tier == "routing_tuple"


def test_tier_three_is_the_session_key(sources, origin_mod, registry, bound) -> None:
    """Reached when the lane drifted — a topic-recovery rewrite or a rotation —
    but the session key still names the same conversation. The verification below
    still has to pass, so this is a lookup shortcut, not an escape hatch."""
    telegram = StubAdapter(Platform.TELEGRAM)
    runner = StubRunner({Platform.TELEGRAM: telegram})
    source = telegram.build_source(chat_id="c", chat_type="dm", user_id="u")
    registry.put(source, session_key="s-stable")
    # Poison the routing index so tier 2 misses but tier 3 can still hit.
    registry.forget_routing_tuple(("telegram", "", "c", ""))

    bound(platform="telegram", chat_id="c", session_key="s-stable")
    origin = origin_mod.resolve_origin(registry=registry, runner=runner)
    assert origin.source is source
    assert origin.tier == "session_key"


def test_no_captured_source_refuses_with_no_origin(origin_mod, registry, bound) -> None:
    runner = StubRunner({Platform.TELEGRAM: StubAdapter(Platform.TELEGRAM)})
    bound(platform="telegram", chat_id="c", session_key="s")

    assert origin_mod.resolve_origin(registry=registry, runner=runner) == {"error": "no_origin"}


def test_resolve_origin_never_reconstructs_a_source(origin_mod, registry, bound) -> None:
    """A bound context is enough to *build* a plausible source. Doing so is
    exactly the lossy path §4 rejects, so a bound context with an empty store
    must still refuse."""
    runner = StubRunner({Platform.TELEGRAM: StubAdapter(Platform.TELEGRAM)})
    bound(
        platform="telegram",
        chat_id="c",
        thread_id="t",
        profile="p",
        session_key="s",
    )
    assert origin_mod.resolve_origin(registry=registry, runner=runner) == {"error": "no_origin"}
    assert len(registry) == 0


# ── the mandatory verification ─────────────────────────────────────────────


def test_an_inherited_foreign_source_on_an_internal_turn_is_refused(
    sources, origin_mod, registry, bound
) -> None:
    """The reachable case the review demanded. An internal wake turn never runs
    the capture hook (``gateway/run.py:13633``), so a ``_TURN_SOURCE`` inherited
    from a concurrent turn can survive the whole turn. Verification turns a
    cross-session leak into a refusal."""
    telegram = StubAdapter(Platform.TELEGRAM)
    discord = StubAdapter(Platform.DISCORD)
    runner = StubRunner({Platform.TELEGRAM: telegram, Platform.DISCORD: discord})

    foreign = discord.build_source(chat_id="discord-chat", chat_type="channel", user_id="other")
    sources.capture(event=make_event(foreign), registry=registry, session_key="foreign")

    # This turn's real identity is a Telegram DM; the inherited contextvar is not.
    bound(platform="telegram", chat_id="tg-chat", session_key="mine")

    result = origin_mod.resolve_origin(registry=registry, runner=runner)
    assert result == {"error": "origin_mismatch"}
    assert discord.sent == [] and telegram.sent == []


def test_a_stale_store_entry_whose_thread_lane_drifted_is_refused(
    origin_mod, registry, bound
) -> None:
    """``_apply_topic_recovery`` replaces ``event.source`` via
    ``dataclasses.replace`` before ``build_session_key``
    (``gateway/platforms/base.py:3306-3325``, called ``:5552``), so a stored
    entry's thread lane can go stale."""
    telegram = StubAdapter(Platform.TELEGRAM)
    runner = StubRunner({Platform.TELEGRAM: telegram})
    stale = telegram.build_source(
        chat_id="c", chat_type="dm", user_id="u", thread_id="old-topic"
    )
    registry.put(stale, session_key="s")

    bound(platform="telegram", chat_id="c", thread_id="new-topic", session_key="s")
    assert origin_mod.resolve_origin(registry=registry, runner=runner) == {
        "error": "origin_mismatch"
    }


def test_a_profile_mismatch_is_refused(origin_mod, registry, bound) -> None:
    """Cross-profile leakage is the same class of failure as cross-platform."""
    telegram = StubAdapter(Platform.TELEGRAM)
    runner = StubRunner({Platform.TELEGRAM: telegram})
    source = telegram.build_source(chat_id="c", chat_type="dm", user_id="u")
    source.profile = "profile-a"
    registry.put(source, session_key="s")

    bound(platform="telegram", chat_id="c", profile="profile-b", session_key="s")
    assert origin_mod.resolve_origin(registry=registry, runner=runner) == {
        "error": "origin_mismatch"
    }


def test_verification_passes_when_every_field_agrees(origin_mod, registry, bound) -> None:
    telegram = StubAdapter(Platform.TELEGRAM)
    runner = StubRunner(
        {Platform.TELEGRAM: telegram},
        profile_adapters={"profile-a": {Platform.TELEGRAM: telegram}},
    )
    source = telegram.build_source(
        chat_id="c", chat_type="dm", user_id="u", thread_id="topic-1"
    )
    source.profile = "profile-a"
    registry.put(source, session_key="s")

    bound(
        platform="telegram",
        chat_id="c",
        thread_id="topic-1",
        profile="profile-a",
        session_key="s",
    )
    origin = origin_mod.resolve_origin(registry=registry, runner=runner)
    assert origin.source is source


def test_an_unverifiable_origin_is_refused_rather_than_trusted(
    sources, origin_mod, registry
) -> None:
    """No bound context at all — today's plugin slash-command path, where
    ``reset_session_vars()`` has run (``gateway/run.py:13581-13585``) and
    ``_set_session_env`` has not (``:15641``). A real source is available but
    there is nothing to verify it against, so it is refused.

    This is a deliberate strengthening of §4, which names only ``no_origin`` and
    ``origin_mismatch``: accepting an unverifiable origin would reintroduce
    exactly the unverified-identity gap Tier 2 (S9) exists to close."""
    telegram = StubAdapter(Platform.TELEGRAM)
    runner = StubRunner({Platform.TELEGRAM: telegram})
    source = telegram.build_source(chat_id="c", chat_type="dm", user_id="u")
    sources.capture(event=make_event(source), registry=registry, session_key="s")

    assert origin_mod.resolve_origin(registry=registry, runner=runner) == {
        "error": "origin_unverified"
    }


# ── adapter resolution ─────────────────────────────────────────────────────


def test_a_missing_runner_refuses_with_gateway_unavailable(
    sources, origin_mod, registry, bound
) -> None:
    telegram = StubAdapter(Platform.TELEGRAM)
    source = telegram.build_source(chat_id="c", chat_type="dm", user_id="u")
    sources.capture(event=make_event(source), registry=registry, session_key="s")
    bound(platform="telegram", chat_id="c", session_key="s")

    assert origin_mod.resolve_origin(registry=registry, runner=None) == {
        "error": "gateway_unavailable"
    }


def test_no_live_adapter_refuses_with_no_adapter(sources, origin_mod, registry, bound) -> None:
    telegram = StubAdapter(Platform.TELEGRAM)
    runner = StubRunner({})  # nothing registered
    source = telegram.build_source(chat_id="c", chat_type="dm", user_id="u")
    sources.capture(event=make_event(source), registry=registry, session_key="s")
    bound(platform="telegram", chat_id="c", session_key="s")

    assert origin_mod.resolve_origin(registry=registry, runner=runner) == {"error": "no_adapter"}


def test_a_stamped_secondary_profile_with_no_adapter_fails_closed(
    sources, origin_mod, registry, bound
) -> None:
    """``_authorization_adapter`` refuses to fall back to the default profile's
    same-platform adapter (``gateway/authz_mixin.py:91-97``) — that would send
    replies out of the wrong bot.

    Multiplexing is on because only a multiplex gateway serves secondary profiles
    and populates ``_profile_adapters``. Hermes 0.21.5's ``_intake_adapter_for``
    reads a non-multiplex gateway as standalone, one adapter per platform, and
    answers with the primary. With multiplexing off, this arrangement no longer
    describes a secondary profile at all."""
    telegram = StubAdapter(Platform.TELEGRAM)
    runner = StubRunner(
        {Platform.TELEGRAM: telegram},
        profile_adapters={"secondary": {}},
        config=GatewayConfig(multiplex_profiles=True),
    )

    # A restored source, i.e. no transport provenance, stamped with a profile
    # whose adapter never connected.
    from gateway.session import SessionSource

    source = SessionSource(
        platform=Platform.TELEGRAM, chat_id="c", chat_type="dm", user_id="u", profile="secondary"
    )
    registry.put(source, session_key="s")
    bound(platform="telegram", chat_id="c", profile="secondary", session_key="s")

    assert origin_mod.resolve_origin(registry=registry, runner=runner) == {"error": "no_adapter"}


def test_the_object_handed_to_adapter_resolution_is_the_captured_one(
    sources, origin_mod, registry, bound, monkeypatch
) -> None:
    """Identity assertion. If any copy, replace, or reconstruction crept in,
    adapter resolution would lose ``_transport_adapter_ref`` and
    ``delivered_via_upstream_relay`` and start resolving by platform lookup.

    Spies on whichever seam the installed Hermes mixin has, so the assertion
    holds on 0.21.3 (``_adapter_for_source``) and 0.21.5+ (``_delivery_adapter_for``)."""
    telegram = StubAdapter(Platform.TELEGRAM)
    runner = StubRunner({Platform.TELEGRAM: telegram})
    source = telegram.build_source(
        chat_id="c", chat_type="dm", user_id="u", scope_id="scope-1"
    )
    sources.capture(event=make_event(source), registry=registry, session_key="s")
    bound(platform="telegram", chat_id="c", session_key="s")

    seam = _installed_adapter_seam()
    seen = []
    real = getattr(runner, seam)

    def spy(arg):
        seen.append(arg)
        return real(arg)

    monkeypatch.setattr(runner, seam, spy)
    origin = origin_mod.resolve_origin(registry=registry, runner=runner)

    assert len(seen) == 1
    assert seen[0] is source
    assert seen[0].scope_id == "scope-1"
    assert seen[0]._transport_adapter_ref() is telegram
    assert origin.source is seen[0]


def test_relay_delivered_sources_resolve_to_the_relay_adapter(
    origin_mod, registry, bound
) -> None:
    """``delivered_via_upstream_relay`` is excluded from ``to_dict``
    (``gateway/session.py:194-206``) — no reconstruction can carry it — and it is
    what the gateway's adapter resolution keys relay delivery off
    (``gateway/authz_mixin.py``). Keeping the real object is what makes
    this work at all."""
    relay = StubAdapter(Platform.RELAY)
    discord = StubAdapter(Platform.DISCORD)
    runner = StubRunner({Platform.RELAY: relay, Platform.DISCORD: discord})

    from gateway.session import SessionSource

    source = SessionSource(
        platform=Platform.DISCORD, chat_id="c", chat_type="channel", user_id="u"
    )
    source.delivered_via_upstream_relay = True
    registry.put(source, session_key="s")
    bound(platform="discord", chat_id="c", session_key="s")

    origin = origin_mod.resolve_origin(registry=registry, runner=runner)
    assert origin.adapter is relay


# ── the adapter-resolution seam, across Hermes versions ────────────────────
#
# Hermes 0.21.5 removed ``GatewayAuthorizationMixin._adapter_for_source`` and split
# it into ``_intake_adapter_for`` / ``_delivery_adapter_for`` (upstream
# ``c70565ef30``). Resolution swallows exceptions into ``no_adapter``, so that
# rename degraded every post into a silent refusal. These pin the seam choice
# independently of the installed Hermes, and fail loudly if it moves again.

_SEAMS = ("_delivery_adapter_for", "_adapter_for_source")


def _installed_adapter_seam() -> str:
    from gateway.authz_mixin import GatewayAuthorizationMixin

    for name in _SEAMS:
        if callable(getattr(GatewayAuthorizationMixin, name, None)):
            return name
    raise AssertionError(
        "the installed GatewayAuthorizationMixin exposes neither _delivery_adapter_for nor "
        "_adapter_for_source; hermes-drop would refuse every post with no_adapter"
    )


def test_the_installed_gateway_exposes_an_adapter_seam_drop_knows() -> None:
    """Canary: a third rename must fail here, not as ``no_adapter`` everywhere."""
    assert _installed_adapter_seam() in _SEAMS


class _SeamRunner:
    """A runner offering exactly the seams named, each recording its calls.

    ``adapters`` is populated on purpose: a resolver that fell back to a platform
    lookup when no seam answered would find an adapter here and be caught."""

    def __init__(self, adapter, *seams, raises: bool = False, answer: object = "adapter"):
        self.adapters = {Platform.TELEGRAM: adapter}
        self.calls: list = []
        for name in seams:
            def seam(source, _name=name):
                self.calls.append((_name, source))
                if raises:
                    raise RuntimeError("adapter resolution exploded")
                return adapter if answer == "adapter" else answer

            setattr(self, name, seam)


def _captured_telegram(sources, registry, bound):
    telegram = StubAdapter(Platform.TELEGRAM)
    source = telegram.build_source(chat_id="c", chat_type="dm", user_id="u")
    sources.capture(event=make_event(source), registry=registry, session_key="s")
    bound(platform="telegram", chat_id="c", session_key="s")
    return telegram, source


@pytest.mark.parametrize("seam", _SEAMS)
def test_either_hermes_seam_resolves_the_origin(seam, sources, origin_mod, registry, bound) -> None:
    telegram, source = _captured_telegram(sources, registry, bound)
    runner = _SeamRunner(telegram, seam)

    origin = origin_mod.resolve_origin(registry=registry, runner=runner)

    assert origin.adapter is telegram
    assert runner.calls == [(seam, source)]


def test_the_delivery_seam_wins_when_both_exist(sources, origin_mod, registry, bound) -> None:
    """Drop posts and edits, so it asks "which bot answers", not "which received"."""
    telegram, source = _captured_telegram(sources, registry, bound)
    runner = _SeamRunner(telegram, *_SEAMS)

    origin_mod.resolve_origin(registry=registry, runner=runner)

    assert runner.calls == [("_delivery_adapter_for", source)]


def test_a_runner_with_no_known_seam_fails_closed_without_a_platform_fallback(
    sources, origin_mod, registry, bound
) -> None:
    telegram, _source = _captured_telegram(sources, registry, bound)
    runner = _SeamRunner(telegram)  # no seam; runner.adapters still has telegram

    assert origin_mod.resolve_origin(registry=registry, runner=runner) == {"error": "no_adapter"}
    assert telegram.sent == []


@pytest.mark.parametrize("seam", _SEAMS)
@pytest.mark.parametrize("failure", ["raises", "answers_none"])
def test_a_seam_that_raises_or_answers_none_fails_closed(
    seam, failure, sources, origin_mod, registry, bound
) -> None:
    telegram, _source = _captured_telegram(sources, registry, bound)
    runner = _SeamRunner(
        telegram, seam, raises=failure == "raises", answer=None if failure == "answers_none" else "adapter"
    )

    assert origin_mod.resolve_origin(registry=registry, runner=runner) == {"error": "no_adapter"}


# ── the origin object itself ───────────────────────────────────────────────


def test_origin_exposes_the_routing_tuple_and_reply_anchor(
    sources, origin_mod, registry, bound
) -> None:
    telegram = StubAdapter(Platform.TELEGRAM)
    runner = StubRunner({Platform.TELEGRAM: telegram})
    source = telegram.build_source(
        chat_id="c", chat_type="dm", user_id="u", thread_id="topic-2", message_id="m-77"
    )
    sources.capture(event=make_event(source), registry=registry, session_key="s")
    bound(
        platform="telegram", chat_id="c", thread_id="topic-2", session_key="s", message_id="m-77"
    )

    origin = origin_mod.resolve_origin(registry=registry, runner=runner)
    assert origin.routing_tuple == ("telegram", "", "c", "topic-2")
    assert origin.reply_anchor == "m-77"
    assert origin.platform_name == "telegram"


def test_origin_is_immutable(sources, origin_mod, registry, bound) -> None:
    """A mutable origin is a mutable destination. The whole guarantee is that the
    chat id cannot be changed after resolution."""
    telegram = StubAdapter(Platform.TELEGRAM)
    runner = StubRunner({Platform.TELEGRAM: telegram})
    source = telegram.build_source(chat_id="c", chat_type="dm", user_id="u")
    sources.capture(event=make_event(source), registry=registry, session_key="s")
    bound(platform="telegram", chat_id="c", session_key="s")

    origin = origin_mod.resolve_origin(registry=registry, runner=runner)
    with pytest.raises(Exception):
        origin.source = None  # type: ignore[misc]


def test_gateway_run_is_imported_lazily_when_no_runner_is_passed(origin_mod) -> None:
    """``_gateway_runner_ref`` must be read *inside* the function: it is a module
    global rebound in ``GatewayRunner.__init__`` (``gateway/run.py:5513, 5536``),
    so a module-scope import captures the ``lambda: None`` sentinel at ``:3121``
    forever. Core imports it inside the function for the same reason
    (``tools/send_message_tool.py:1823``)."""
    import inspect

    src = inspect.getsource(origin_mod)
    assert "from gateway.run import" not in src.split("def ")[0], (
        "gateway.run imported at module scope"
    )
    assert "_gateway_runner_ref" in src
