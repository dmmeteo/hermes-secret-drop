"""The trusted no-model consumer boundary.

Two properties are under test here and they are not the same property.

**Fail closed.** Nothing ships in the registry, so a form containing a ``secret`` field
is refused at mint on any real deployment. These tests assert that as shipped behaviour
rather than as a configuration accident.

**Value-free by construction.** The receipt a model sees is built from the validated
contract and a fixed status enum. The tests below therefore attack the *construction*:
consumers that return strings, dicts, extra fields, ``None``, or that raise. None of
them can put a value in front of a model, because no value is in scope when a receipt is
built -- which is a different and stronger claim than "we searched the receipt and found
nothing".

What is deliberately **not** claimed: protection against a malicious host-side plugin. A
consumer runs as the host user and can exfiltrate without returning anything. These
tests are about accidents and bugs, which is what the boundary is for.
"""

from __future__ import annotations

import pytest

from conftest import load_plugin_package

# Through the suite's own loader — see the note in test_form_contract.py. It also keeps
# `ConsumerStatus` a single class: a second copy of the module would make the
# `isinstance` check in `deliver_bundle` compare against a different one.
_plugin = load_plugin_package()
consumers = _plugin.drop.consumers
fc = _plugin.drop.form_contract

SECRET_VALUE = "sk-live-DO-NOT-RETURN-THIS-0123456789"

CREDENTIAL_PAIR = {
    "version": 1,
    "title": "Staging console sign-in",
    "fields": [
        {"id": "username", "type": "text", "label": "Username", "required": True},
        {"id": "password", "type": "secret", "label": "Password", "required": True},
    ],
}

SECRET_WITH_FILES = {
    "version": 1,
    "title": "Rotate the deploy key",
    "fields": [
        {"id": "passphrase", "type": "secret", "label": "Passphrase", "required": True},
        {"id": "key_file", "type": "files", "label": "Private key", "required": True},
    ],
}


def contract_of(raw):
    return fc.validate_form_contract(raw, max_files=5)


def bundle_for(contract, *, values=(("password", SECRET_VALUE),), files=()):
    return consumers.SecretBundle(
        drop_id="D" * 22,
        contract=contract,
        contract_digest="a" * 64,
        delivery_token="t" * 64,
        values=tuple(values),
        files=tuple(files),
    )


class Canary:
    """The synthetic consumer. Lives in the test suite and is never registered."""

    name = "canary"

    def __init__(self, *, accepts=True, status=consumers.ConsumerStatus.DELIVERED):
        self._accepts = accepts
        self._status = status
        self.received = []

    def accepts(self, contract):
        return self._accepts

    def deliver(self, bundle):
        self.received.append(bundle)
        return self._status


# ── fail closed ────────────────────────────────────────────────────────────


def test_nothing_is_registered_in_the_shipped_package():
    # The single most important assertion in this file. If this ever fails, a
    # production deployment has gained a secret sink nobody authorized.
    assert consumers.BUILT_IN == {}


@pytest.mark.parametrize("name", [None, "", "canary", "does-not-exist", 17, True])
def test_resolution_fails_closed_against_the_shipped_registry(name):
    with pytest.raises(consumers.ConsumerUnavailable) as caught:
        consumers.resolve_consumer(name, contract_of(CREDENTIAL_PAIR))
    assert caught.value.code == "secret_consumer_unavailable"


def test_a_consumer_that_declines_the_contract_is_not_a_consumer_for_this_drop():
    registry = {"canary": Canary(accepts=False)}
    with pytest.raises(consumers.ConsumerUnavailable) as caught:
        consumers.resolve_consumer("canary", contract_of(CREDENTIAL_PAIR), registry=registry)
    assert caught.value.code == "secret_consumer_rejected"


def test_accepts_returning_something_that_is_not_true_is_not_acceptance():
    class Sloppy(Canary):
        def accepts(self, contract):
            return "yes"  # truthy, and not an acceptance

    with pytest.raises(consumers.ConsumerUnavailable) as caught:
        consumers.resolve_consumer("canary", contract_of(CREDENTIAL_PAIR), registry={"canary": Sloppy()})
    assert caught.value.code == "secret_consumer_rejected"


def test_accepts_that_raises_is_a_contract_error_and_quotes_nothing():
    class Exploding(Canary):
        def accepts(self, contract):
            raise RuntimeError(f"boom {SECRET_VALUE}")

    with pytest.raises(consumers.ConsumerUnavailable) as caught:
        consumers.resolve_consumer("canary", contract_of(CREDENTIAL_PAIR), registry={"canary": Exploding()})
    assert caught.value.code == "consumer_contract_error"
    assert SECRET_VALUE not in str(caught.value)


def test_the_synthetic_consumer_resolves_through_the_real_path():
    # The registry is injected rather than mutated globally, so this exercises exactly
    # the resolution production uses without leaving a writable table behind.
    canary = Canary()
    resolved = consumers.resolve_consumer(
        "canary", contract_of(CREDENTIAL_PAIR), registry={"canary": canary}
    )
    assert resolved is canary


# ── the whole bundle, including files ──────────────────────────────────────


def test_a_secret_form_may_contain_files_and_the_whole_bundle_goes_to_the_consumer():
    contract = contract_of(SECRET_WITH_FILES)
    assert contract is not None  # the engine supports the combination
    canary = Canary()
    bundle = bundle_for(
        contract,
        values=(("passphrase", SECRET_VALUE),),
        files=({"field": "key_file", "name": "id_ed25519", "size": 400, "sha256": "b" * 64},),
    )
    assert consumers.deliver_bundle(canary, bundle) is consumers.ConsumerStatus.DELIVERED
    delivered = canary.received[0]
    # Whole, not split: the consumer sees every field, and the model sees none of them.
    assert delivered.values == (("passphrase", SECRET_VALUE),)
    assert delivered.files[0]["field"] == "key_file"


# ── hostile returns ────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "returned",
    [
        f"delivered, and the value was {SECRET_VALUE}",
        {"status": "delivered", "value": SECRET_VALUE},
        ["delivered", SECRET_VALUE],
        None,
        True,
        17,
        "delivered",
    ],
    ids=["string", "dict", "list", "none", "bool", "int", "bare_status_string"],
)
def test_anything_that_is_not_a_status_member_becomes_failed(returned):
    class Hostile(Canary):
        def deliver(self, bundle):
            return returned

    status = consumers.deliver_bundle(Hostile(), bundle_for(contract_of(CREDENTIAL_PAIR)))
    # A bug in the component holding the secret reads as "we do not know what happened".
    assert status is consumers.ConsumerStatus.FAILED


def test_a_consumer_that_raises_never_has_its_message_repeated():
    class Exploding(Canary):
        def deliver(self, bundle):
            raise RuntimeError(f"failed while writing {SECRET_VALUE}")

    status = consumers.deliver_bundle(Exploding(), bundle_for(contract_of(CREDENTIAL_PAIR)))
    assert status is consumers.ConsumerStatus.FAILED


def test_a_raising_consumer_puts_nothing_in_the_log(caplog):
    class Exploding(Canary):
        def deliver(self, bundle):
            raise RuntimeError(f"failed while writing {SECRET_VALUE}")

    with caplog.at_level("DEBUG"):
        consumers.deliver_bundle(Exploding(), bundle_for(contract_of(CREDENTIAL_PAIR)))
    assert SECRET_VALUE not in caplog.text


# ── the receipt is a construction, not a filter ────────────────────────────


@pytest.mark.parametrize(
    "status",
    [consumers.ConsumerStatus.DELIVERED, consumers.ConsumerStatus.REJECTED, consumers.ConsumerStatus.FAILED],
)
def test_a_receipt_carries_no_value_for_any_status(status):
    contract = contract_of(CREDENTIAL_PAIR)
    receipt = consumers.build_receipt(
        drop_id="D" * 22,
        contract=contract,
        consumer_name="canary",
        status=status,
        token="t" * 64,
        submitted_field_ids=["username", "password"],
    )
    flat = repr(receipt)
    assert SECRET_VALUE not in flat
    # The ids are the requester's own machine names and are not secret; the model needs
    # them to know which request was answered.
    assert receipt["field_ids"] == ["username", "password"]
    assert receipt["counts"] == {"fields": 2, "answered": 2, "files": 0, "file_fields": 0}
    assert receipt["consumer"] == "canary"
    assert set(receipt) == {
        "ok", "drop_id", "state", "consumer", "delivery_token",
        "field_ids", "answered_field_ids", "counts",
    }


def test_a_receipt_cannot_report_a_field_the_contract_does_not_have():
    contract = contract_of(CREDENTIAL_PAIR)
    receipt = consumers.build_receipt(
        drop_id="D" * 22,
        contract=contract,
        consumer_name="canary",
        status=consumers.ConsumerStatus.DELIVERED,
        token="t" * 64,
        # An id from nowhere -- intersected against the contract rather than trusted.
        submitted_field_ids=["username", "smuggled_" + SECRET_VALUE],
    )
    assert receipt["answered_field_ids"] == ["username"]
    assert SECRET_VALUE not in repr(receipt)


def test_only_delivered_is_reported_as_delivered():
    contract = contract_of(CREDENTIAL_PAIR)
    states = {
        status: consumers.build_receipt(
            drop_id="D" * 22, contract=contract, consumer_name="canary",
            status=status, token="t" * 64, submitted_field_ids=["username"],
        )["state"]
        for status in consumers.ConsumerStatus
    }
    assert states == {
        consumers.ConsumerStatus.DELIVERED: "delivered",
        consumers.ConsumerStatus.REJECTED: "rejected",
        consumers.ConsumerStatus.FAILED: "failed",
    }


# ── idempotency ────────────────────────────────────────────────────────────


def test_the_delivery_token_is_stable_and_specific():
    one = consumers.delivery_token("drop-a", "d" * 64, "canary")
    assert one == consumers.delivery_token("drop-a", "d" * 64, "canary")
    # A different drop, contract or consumer is a different delivery.
    assert one != consumers.delivery_token("drop-b", "d" * 64, "canary")
    assert one != consumers.delivery_token("drop-a", "e" * 64, "canary")
    assert one != consumers.delivery_token("drop-a", "d" * 64, "other")
    assert len(one) == 64


def test_the_token_reaches_the_consumer_so_an_idempotent_sink_can_use_it():
    canary = Canary()
    token = consumers.delivery_token("D" * 22, "a" * 64, "canary")
    bundle = consumers.SecretBundle(
        drop_id="D" * 22, contract=contract_of(CREDENTIAL_PAIR),
        contract_digest="a" * 64, delivery_token=token,
        values=(("password", SECRET_VALUE),),
    )
    consumers.deliver_bundle(canary, bundle)
    assert canary.received[0].delivery_token == token


def test_every_error_code_is_declared():
    for code in consumers.CONSUMER_ERRORS:
        assert isinstance(code, str)
    with pytest.raises(AssertionError):
        consumers.ConsumerUnavailable("not_a_declared_code")
