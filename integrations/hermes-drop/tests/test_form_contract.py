"""The declarative form contract, producer side, against the SHARED case table.

The table is ``test/fixtures/form-contract-vectors.json`` at the repository root and
``test/form-contract.test.js`` runs the same file. That is the point: two
implementations of one schema is a drift risk taken deliberately, and the only thing
that makes it safe is that both sides are held to one table -- including the exact
canonical bytes, whose SHA-256 the HPKE ``info`` binds. A disagreement here is not a
style difference; it is a drop that can never be opened.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from conftest import load_plugin_package

# Through the suite's own loader, never `from drop import ...`: a bare import only
# resolves when pytest happens to be run from inside the plugin directory, and the gate
# runs it from the repository root.
fc = load_plugin_package().drop.form_contract

VECTORS = json.loads(
    (Path(__file__).resolve().parents[3] / "test" / "fixtures" / "form-contract-vectors.json")
    .read_text(encoding="utf-8")
)


@pytest.mark.parametrize("vector", VECTORS["accepted"], ids=lambda v: v["name"])
def test_accepted_vectors_canonicalize_byte_for_byte(vector):
    contract = fc.validate_form_contract(vector["contract"], max_files=5)
    assert contract is not None

    delivery = fc.delivery_for(contract, vector["consumer"])
    assert delivery == vector["delivery"]

    canonical = fc.canonicalize(contract, delivery)
    assert canonical == vector["canonical"]
    # Derived from the canonical string rather than stored beside it, so the table
    # cannot claim a digest its own canonical form does not produce.
    assert fc.contract_digest(contract, delivery) == hashlib.sha256(
        vector["canonical"].encode("utf-8")
    ).hexdigest()


@pytest.mark.parametrize("vector", VECTORS["refused"], ids=lambda v: v["name"])
def test_refused_vectors_carry_the_same_code(vector):
    with pytest.raises(fc.FormContractRejected) as caught:
        fc.validate_form_contract(vector["contract"], max_files=5)
    assert caught.value.reason == vector["reason"]
    # A refusal is a code from the closed set and nothing else: no offending value, and
    # nothing that varied with the input. It becomes a tool result, and a tool result
    # reaches the model's context and from there durable session state.
    assert caught.value.reason in fc.FORM_CONTRACT_REASONS


def test_the_table_reaches_every_declared_reason_but_the_backstop():
    covered = {vector["reason"] for vector in VECTORS["refused"]}
    # `contract_too_large` is unreachable through validated parts -- every part is
    # bounded and their sum is under the ceiling. It stays as a backstop, and the
    # JavaScript suite measures the maximal contract against it.
    for reason in fc.FORM_CONTRACT_REASONS:
        if reason == "contract_too_large":
            continue
        assert reason in covered, reason


def test_absence_is_absence_and_not_an_empty_contract():
    assert fc.validate_form_contract(None) is None


def test_defaults_are_filled_in_so_the_digest_means_something():
    contract = fc.validate_form_contract(
        {"version": 1, "fields": [{"id": "f", "type": "files", "label": "Logs"}]},
        max_files=5,
    )
    # A default supplies a value the caller declined to choose; a repair changes one it
    # did choose. This is the former, and determinism needs it to be explicit.
    assert contract["fields"][0] == {
        "id": "f",
        "type": "files",
        "label": "Logs",
        "required": False,
        "min_files": 1,
        "max_files": 1,
    }


def test_the_callers_object_is_not_mutated():
    raw = {"version": 1, "fields": [{"id": "a", "type": "text", "label": "A"}]}
    before = json.dumps(raw, sort_keys=True)
    fc.validate_form_contract(raw, max_files=5)
    assert json.dumps(raw, sort_keys=True) == before


def test_delivery_is_derived_from_the_field_types_and_never_from_a_caller():
    plain = fc.validate_form_contract(
        {"version": 1, "fields": [{"id": "a", "type": "text", "label": "A"}]}
    )
    # A consumer name offered for a contract with no secret field is simply not used:
    # there is no way to ask for the consumer lane, only ways to be put in it.
    assert fc.delivery_for(plain, "canary") == {"mode": "model", "consumer": None}

    secret = fc.validate_form_contract(
        {"version": 1, "fields": [{"id": "a", "type": "secret", "label": "A"}]}
    )
    assert fc.delivery_for(secret, "canary") == {"mode": "consumer", "consumer": "canary"}
    # ...and with no name there is nothing to bind, which is what the mint gate refuses.
    assert fc.delivery_for(secret, None) == {"mode": "consumer", "consumer": None}


def test_the_consumer_name_is_part_of_the_identity():
    contract = fc.validate_form_contract(
        {"version": 1, "fields": [{"id": "a", "type": "secret", "label": "A"}]}
    )
    one = fc.contract_digest(contract, fc.delivery_for(contract, "canary"))
    two = fc.contract_digest(contract, fc.delivery_for(contract, "other"))
    # Two consumers are two contracts. A drop minted for one cannot be opened as a drop
    # for the other, because the digest is bound into the AEAD.
    assert one != two


@pytest.mark.parametrize(
    "created,expected",
    [
        ({"ok": True, "form_protocol": 2}, True),
        ({"ok": True, "form_protocol": 3}, True),
        # 1 is the legacy descriptor's floor, and a broker there cannot render a
        # contract at all. Absence means "cannot", never "probably fine".
        ({"ok": True, "form_protocol": 1}, False),
        ({"ok": True}, False),
        ({"ok": True, "form_protocol": True}, False),
        ({"ok": True, "form_protocol": "2"}, False),
        (None, False),
    ],
)
def test_the_pre_flight_capability_check_fails_closed(created, expected):
    assert fc.supports_form_contract(created) is expected
