"""Where a claimed form actually goes, at the service seam.

This is the file that proves the engine's central promise: a contract bound to a
consumer never becomes a tool result with values in it, and there is no argument, no
mode and no downgrade that reaches the other branch.

The tests drive ``DropService.claim`` with a control stub answering the shape a real
broker answers with, because that response -- not anything this process remembers -- is
what the routing decision is read from. A reconciled claim after a restart has no
in-memory context, so a mode recovered from local state could be a mode for a different
drop.
"""

from __future__ import annotations

import pytest
from gateway.config import Platform

from _stubs import StubAdapter, StubRunner
from conftest import load_plugin_package

# Marked per test rather than module-wide: the durable-seam tests at the bottom are
# synchronous, and a blanket asyncio mark makes pytest warn about every one of them.
@pytest.fixture
def plugin():
    return load_plugin_package()


@pytest.fixture
def consumers(plugin):
    # Through the loaded package, never `from drop import consumers`: the two would be
    # distinct module objects, so the `isinstance(status, ConsumerStatus)` check inside
    # `deliver_bundle` would compare against a different class and every delivery would
    # read as FAILED for a reason that has nothing to do with what is under test.
    return plugin.drop.consumers


@pytest.fixture
def vault(plugin):
    return plugin.drop.vault


@pytest.fixture
def journal(plugin, tmp_path):
    return plugin.drop.journal.DropJournal(root=tmp_path / "hermes-drop")


@pytest.fixture
def lane(plugin):
    def _make(platform: Platform = Platform.TELEGRAM, chat_id: str = "tg-1", **kw):
        adapter = StubAdapter(platform, **kw)
        runner = StubRunner({platform: adapter})
        source = adapter.build_source(
            chat_id=chat_id, chat_type="dm", user_id="u-1", thread_id=""
        )
        plugin.drop.sources.REGISTRY.put(source, gateway=runner, session_key="s")
        origin = plugin.drop.origin.Origin(
            source=source,
            adapter=adapter,
            runner=runner,
            routing_tuple=plugin.drop.sources.routing_tuple_for_source(source),
            reply_anchor=None,
            tier="turn_contextvar",
        )
        return origin, adapter

    return _make


@pytest.fixture
def contracts(plugin):
    fc = plugin.drop.form_contract
    return {
        "pair": fc.validate_form_contract(
            {
                "version": 1,
                "title": "Staging console sign-in",
                "fields": [
                    {"id": "username", "type": "text", "label": "Username", "required": True},
                    {"id": "password", "type": "secret", "label": "Password", "required": True},
                ],
            },
            max_files=5,
        ),
        "plain": fc.validate_form_contract(
            {
                "version": 1,
                "fields": [
                    {"id": "release", "type": "text", "label": "Release tag", "required": True},
                    {"id": "notes", "type": "textarea", "label": "Notes"},
                ],
            },
            max_files=5,
        ),
    }

SECRET_VALUE = "sk-live-DO-NOT-RETURN-THIS-0123456789"

class NullWaiters:
    """Arming is a latency optimisation, not part of what these tests are about."""

    def arm(self, drop_id, factory):
        coro = factory()
        coro.close()
        return True

    def is_armed(self, drop_id):
        return False


class FormControl:
    """A control stub answering `create` and `claim` the way a real broker does.

    `create` is needed because a claim is authorized against the journal first, and the
    journal entry only exists because a drop was really minted through this service.
    Short-circuiting that would test a claim path no real caller can reach.
    """

    def __init__(self, form):
        self._form = form

    async def create(
        self, *, ttl_seconds=None, notice_platform=None, payload_kind=None,
        form=None, form_contract=None, consumer=None, socket_path=None, timeout=None,
    ):
        import time as _time

        return {
            "ok": True,
            "handoff_id": "H" * 22,
            "url": "http://127.0.0.1:8080/#Q2FwYWJpbGl0eVN0cmluZ0FB",
            "expires_at": int(_time.time() * 1000) + (ttl_seconds or 1800) * 1000,
            "ttl_seconds": ttl_seconds or 1800,
            "max_plaintext_bytes": 8192,
            "protocol_version": 2,
            "form_protocol": 2,
            "notice": "open the secure form http://127.0.0.1:8080/#Q2FwYWJpbGl0eVN0cmluZ0FB",
            "notice_received": "> \u2713 **Private input received**",
            "notice_expired": "> \u2715 **Private input link expired**",
        }

    async def claim(self, handoff_id, *, wait_ms=0, socket_path=None, timeout=None):
        return {"ok": True, "handoff_id": handoff_id, "form": self._form}


async def _received(plugin, journal, origin, control, **kw):
    """Mint a real drop through the service, then mark it received, as a wake would."""
    service = _service(plugin, journal, control, **kw)
    await service.create(origin, ttl_seconds=300, purpose="engine test")
    journal.update("H" * 22, state=plugin.drop.journal.STATE_RECEIVED)
    return service


class Canary:
    name = "canary"

    def __init__(self, status, *, accepts=True):
        self._accepts = accepts
        self._status = status
        self.received = []

    def accepts(self, contract):
        return self._accepts

    def deliver(self, bundle):
        self.received.append(bundle)
        return self._status


def _form_response(contract, delivery, values):
    return {
        "contract_digest": "a" * 64,
        "contract": contract,
        "delivery": delivery,
        "values": [{"field": k, "value": v} for k, v in values],
    }


def _service(plugin, journal, control, **kw):
    return plugin.drop.service.DropService(
        journal=journal, control=control, waiters=NullWaiters(), **kw
    )


@pytest.mark.asyncio
async def test_a_model_form_returns_its_values_keyed_by_id(plugin, journal, lane, contracts):
    origin, _ = lane()
    control = FormControl(
        _form_response(
            contracts["plain"],
            {"mode": "model", "consumer": None},
            [("release", "v2026.9.13"), ("notes", "  kept  exactly  ")],
        )
    )
    service = await _received(plugin, journal, origin, control)
    result = await service.claim(origin, "H" * 22)

    assert result["ok"] is True
    assert result["private_values"] == [
        {"id": "release", "value": "v2026.9.13"},
        # Whitespace a person typed is theirs. Nothing on this path trims it.
        {"id": "notes", "value": "  kept  exactly  "},
    ]


@pytest.mark.asyncio
async def test_a_consumer_form_returns_a_receipt_and_never_a_value(
    plugin, journal, lane, contracts, consumers
):
    origin, _ = lane()
    canary = Canary(consumers.ConsumerStatus.DELIVERED)
    control = FormControl(
        _form_response(
            contracts["pair"],
            {"mode": "consumer", "consumer": "canary"},
            [("username", "ada"), ("password", SECRET_VALUE)],
        )
    )
    service = await _received(plugin, journal, origin, control, consumer_registry={"canary": canary})
    result = await service.claim(origin, "H" * 22)

    # The consumer got everything...
    assert canary.received[0].values == (("username", "ada"), ("password", SECRET_VALUE))
    # ...and the model got none of it.
    assert SECRET_VALUE not in repr(result)
    assert "private_values" not in result
    assert "private_input" not in result
    assert result["state"] == "delivered"
    assert result["consumer"] == "canary"
    assert result["field_ids"] == ["username", "password"]
    assert len(result["delivery_token"]) == 64


@pytest.mark.asyncio
async def test_a_consumer_that_is_gone_at_claim_time_fails_closed(
    plugin, journal, lane, contracts
):
    origin, _ = lane()
    control = FormControl(
        _form_response(
            contracts["pair"],
            {"mode": "consumer", "consumer": "canary"},
            [("password", SECRET_VALUE)],
        )
    )
    # Minted for `canary`; by claim time the operator has removed it. The drop is spent
    # either way -- what must not happen is the values going somewhere else, or back.
    service = await _received(plugin, journal, origin, control, consumer_registry={})
    result = await service.claim(origin, "H" * 22)

    assert result == {"error": "secret_consumer_unavailable"}
    assert SECRET_VALUE not in repr(result)


@pytest.mark.asyncio
async def test_a_consumer_that_stops_accepting_after_mint_fails_closed(
    plugin, journal, lane, contracts, consumers
):
    origin, _ = lane()
    control = FormControl(
        _form_response(
            contracts["pair"],
            {"mode": "consumer", "consumer": "canary"},
            [("password", SECRET_VALUE)],
        )
    )
    service = await _received(
        plugin, journal, origin, control,
        consumer_registry={"canary": Canary(consumers.ConsumerStatus.DELIVERED, accepts=False)},
    )
    result = await service.claim(origin, "H" * 22)
    assert result == {"error": "secret_consumer_rejected"}


@pytest.mark.asyncio
async def test_a_hostile_consumer_cannot_smuggle_a_value_into_the_receipt(
    plugin, journal, lane, contracts, consumers
):
    origin, _ = lane()

    class Hostile(Canary):
        def deliver(self, bundle):
            self.received.append(bundle)
            return f"delivered: {bundle.values[0][1]}"

    control = FormControl(
        _form_response(
            contracts["pair"],
            {"mode": "consumer", "consumer": "canary"},
            [("password", SECRET_VALUE)],
        )
    )
    service = await _received(
        plugin, journal, origin, control,
        consumer_registry={"canary": Hostile(consumers.ConsumerStatus.DELIVERED)},
    )
    result = await service.claim(origin, "H" * 22)

    assert SECRET_VALUE not in repr(result)
    # The attempt is reported as a failure rather than silently swallowed: the operator
    # needs to know that sink is broken.
    assert result["state"] == "failed"


@pytest.mark.asyncio
async def test_a_raising_consumer_reports_a_closed_code_and_no_exception_text(
    plugin, journal, lane, caplog, contracts, consumers
):
    origin, _ = lane()

    class Exploding(Canary):
        def deliver(self, bundle):
            raise RuntimeError(f"could not write {SECRET_VALUE}")

    control = FormControl(
        _form_response(
            contracts["pair"],
            {"mode": "consumer", "consumer": "canary"},
            [("password", SECRET_VALUE)],
        )
    )
    service = await _received(
        plugin, journal, origin, control,
        consumer_registry={"canary": Exploding(consumers.ConsumerStatus.DELIVERED)},
    )
    with caplog.at_level("DEBUG"):
        result = await service.claim(origin, "H" * 22)

    assert result["state"] == "failed"
    assert SECRET_VALUE not in repr(result)
    assert SECRET_VALUE not in caplog.text


@pytest.mark.asyncio
async def test_a_broker_claiming_consumer_mode_without_naming_one_delivers_nothing(
    plugin, journal, lane, contracts, consumers
):
    origin, _ = lane()
    control = FormControl(
        _form_response(
            contracts["pair"],
            {"mode": "consumer", "consumer": None},
            [("password", SECRET_VALUE)],
        )
    )
    service = _service(plugin, journal, control, consumer_registry={"canary": Canary(consumers.ConsumerStatus.DELIVERED)})
    result = await service.claim(origin, "H" * 22)
    assert "error" in result
    assert SECRET_VALUE not in repr(result)


# ── the durable seam ───────────────────────────────────────────────────────


def test_structured_values_are_redacted_before_they_can_reach_state_db(vault):
    payload = {
        "ok": True,
        "drop_id": "H" * 22,
        "private_values": [
            {"id": "username", "value": "ada"},
            {"id": "password", "value": SECRET_VALUE},
        ],
    }
    redacted = vault.redact_tool_result(payload, session_id="session-1")
    flat = repr(redacted)
    assert SECRET_VALUE not in flat
    assert "ada" not in flat
    # One placeholder per field, so the model can resolve the one it needs without
    # dragging the others onto the wire.
    for entry in redacted["private_values"]:
        assert vault.PLACEHOLDER_RE.fullmatch(entry["value"])
    assert redacted["private_values"][0]["id"] == "username"


def test_a_receipt_passes_through_the_vault_untouched_because_it_holds_nothing(
    vault, consumers, contracts
):
    receipt = consumers.build_receipt(
        drop_id="H" * 22,
        contract=contracts["pair"],
        consumer_name="canary",
        status=consumers.ConsumerStatus.DELIVERED,
        token="t" * 64,
        submitted_field_ids=["username", "password"],
    )
    assert vault.redact_tool_result(receipt, session_id="session-1") == receipt


@pytest.mark.parametrize(
    "broken",
    [
        {"private_values": "not-a-list"},
        {"private_values": [{"id": "a"}]},
        {"private_values": [{"id": 1, "value": "x"}]},
        {"private_values": [{"id": "a", "value": "x", "extra": 1}]},
    ],
)
def test_an_unrecognised_values_shape_fails_closed_rather_than_passing_through(broken, vault):
    # Passing through is what would serialise a secret into state.db, which is the one
    # outcome this seam exists to prevent.
    with pytest.raises(vault.VaultError):
        vault.redact_tool_result(broken, session_id="session-1")
