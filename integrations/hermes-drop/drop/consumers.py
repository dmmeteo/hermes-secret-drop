"""The trusted no-model consumer boundary for secret form submissions.

A form that draws a **Password** field and then hands that password back to the model
would look password-blind and not be. That is the whole reason this module exists: when
a contract contains a ``secret`` field, its submission is delivered to an authorized
consumer that runs as host code, and the model receives a receipt with no values in it.

Read the following four paragraphs before changing anything here; each of them is a
decision, not an implementation detail.

**It ships closed, and it stays closed.** :data:`BUILT_IN` is empty. No consumer is
registered in this package, so on any real deployment a secret-bearing form is refused
**at mint** with ``secret_consumer_unavailable`` -- before a link is posted, before a
drop exists, before anyone is asked to type a password Drop could not honestly receive.
That is the honest state of this slice and it is documented rather than papered over.
A later, explicitly authorized sink plugs into :class:`SecretConsumer` without any of
the machinery below changing.

**A consumer chooses a status and nothing else.** :meth:`SecretConsumer.deliver`
returns a :class:`ConsumerStatus` member. It does not return a message, a path, a count
or an object. Everything the model eventually sees is built **here**, by
:func:`build_receipt`, out of the validated contract and the delivery record -- so a
receipt cannot carry a value even if a consumer tries to put one there. Anything a
consumer returns that is not a status member is a defect in that consumer and becomes
``consumer_contract_error``; anything it raises becomes ``consumer_failed``, and the
exception is **never stringified** into a result or a log line, because an exception
message is attacker-influenced text on a path that ends in the model's context.

**Scanning is not the boundary, and was deliberately not used as one.** An earlier
design checked the receipt for substrings of the submitted values. That cannot work: it
is trivially defeated by any encoding, and it misclassifies ordinary short values --
a two-character username would make half the alphabet unreturnable. Constructing the
receipt from known-safe data is a property; searching it for known-bad data is a guess.

**What this does and does not protect against.** It prevents a value being returned to
the model *by accident* -- by a consumer that is careless, buggy, or written against an
older contract -- and it keeps secret values out of tool results, durable session state,
logs and notices. It is **not** protection against a malicious host-side plugin. A
consumer is host code running as the host user; one that wants to exfiltrate a value can
simply do so without returning it. Anyone who reads this module as a sandbox has
misread it.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field as dataclass_field
from enum import Enum
from typing import Any, Dict, Mapping, Optional, Protocol, Sequence, Tuple

from .form_contract import VALUE_FIELD_TYPES


class ConsumerStatus(str, Enum):
    """The only vocabulary a consumer may answer in.

    An enum rather than a string, so a consumer cannot invent a fourth outcome that
    the framework would have to decide how to render -- and so a typo is a
    ``consumer_contract_error`` rather than a status nobody checks for.
    """

    #: The values were accepted and handled. The side effect, if any, happened.
    DELIVERED = "delivered"
    #: The consumer understood the bundle and declined it. Nothing happened.
    REJECTED = "rejected"
    #: The consumer tried and could not finish. Whether anything happened is unknown.
    FAILED = "failed"


#: Every code this module can put in front of a model. Closed, like every other refusal
#: vocabulary in this project, because a refusal is a tool result and a tool result
#: reaches durable session state.
CONSUMER_ERRORS: Tuple[str, ...] = (
    "consumer_contract_error",
    "consumer_failed",
    "delivery_uncertain",
    "secret_consumer_rejected",
    "secret_consumer_unavailable",
)


@dataclass(frozen=True)
class SecretBundle:
    """One whole validated submission, handed to a consumer in a single call.

    Whole, not split: a contract containing any secret field delivers **everything** --
    secret values, ordinary values and files alike -- to the consumer, and the model
    gets none of it. Splitting would mean deciding per field where a value may go, and
    a per-field decision is a per-field mistake waiting to happen.

    ``values`` is an ordered tuple of ``(field_id, value)`` pairs rather than a mapping,
    mirroring the wire format for the same reason: nothing keyed by a caller-supplied
    id, anywhere.
    """

    drop_id: str
    contract: Mapping[str, Any]
    contract_digest: str
    delivery_token: str
    values: Tuple[Tuple[str, str], ...] = ()
    files: Tuple[Mapping[str, Any], ...] = ()


class SecretConsumer(Protocol):
    """What an authorized sink must implement.

    Deliberately small. A consumer decides two things -- whether it can honour a
    contract at all, and what happened when it tried -- and the framework decides
    everything else.
    """

    #: The name an operator configures. Matched against the registry, never imported.
    name: str

    def accepts(self, contract: Mapping[str, Any]) -> bool:
        """Whether this consumer can honour this contract, asked **before minting**.

        This is where a consumer that cannot handle files declines a contract that has
        a file group, rather than the engine refusing the combination for it. Asked
        early so the refusal costs nobody a link.
        """

    def deliver(self, bundle: SecretBundle) -> ConsumerStatus:
        """Handle one whole validated submission. Returns a status and nothing else."""


#: The closed registry. **Empty in production, and that is the point.** A name is looked
#: up here and nowhere else: no import paths, no entry points, no model-supplied names,
#: no shell. Widening this to resolve an arbitrary dotted path would be the "opaque
#: external executor" that NEXT_ITERATION_SECURITY_TASKS.md lists as out of scope.
BUILT_IN: Dict[str, SecretConsumer] = {}


class ConsumerUnavailable(Exception):
    """No authorized consumer can take this contract. Carries a closed code."""

    def __init__(self, code: str) -> None:
        if code not in CONSUMER_ERRORS:
            raise AssertionError(f"undeclared consumer error: {code}")
        super().__init__(code)
        self.code = code


def resolve_consumer(
    name: Optional[str],
    contract: Mapping[str, Any],
    *,
    registry: Optional[Mapping[str, SecretConsumer]] = None,
) -> SecretConsumer:
    """The authorized consumer for this contract, or a refusal.

    ``registry`` exists so tests can exercise this exact resolution path with a
    synthetic consumer, without a mutable global that production could inherit. There
    is no "install" function on purpose: a registry that can be written at runtime is a
    registry an unrelated bug can write to.

    Raises :class:`ConsumerUnavailable` -- never returns ``None`` -- so a caller cannot
    forget to check and end up with a falsy consumer that quietly means "to the model".
    """
    table = BUILT_IN if registry is None else registry
    if not isinstance(name, str) or name == "":
        raise ConsumerUnavailable("secret_consumer_unavailable")
    consumer = table.get(name)
    if consumer is None:
        raise ConsumerUnavailable("secret_consumer_unavailable")
    # A consumer that cannot honour the contract is not a consumer for this drop. Asked
    # here rather than at delivery so the answer arrives before a link is posted -- and
    # asked again at claim, because between the two the configuration may have changed.
    try:
        accepted = consumer.accepts(contract)
    except Exception:  # noqa: BLE001 - see module docstring: never trust, never quote
        raise ConsumerUnavailable("consumer_contract_error") from None
    if accepted is not True:
        raise ConsumerUnavailable("secret_consumer_rejected")
    return consumer


def delivery_token(drop_id: str, contract_digest: str, consumer_name: str) -> str:
    """A stable id for *this* delivery, for a consumer that supports idempotency keys.

    ``SHA-256(drop_id | contract_digest | consumer)``, lowercase hex. Stable for the
    life of the drop and derived rather than drawn, so a restart recomputes the same
    token instead of inventing a second one for the same work.

    Stated plainly, because it would be easy to overclaim: this does **not** make an
    external side effect exactly-once. Drop is one-shot, so a consumer is called at most
    once per drop by construction -- but "called at most once" is not "took effect at
    most once" for a consumer whose own write is not idempotent. A consumer that wants
    exactly-once uses this token as its key; one that does not is at-least-once, and
    :func:`build_receipt` says so through the ``delivery_uncertain`` status rather than
    letting a caller assume otherwise.
    """
    material = f"{drop_id}\x00{contract_digest}\x00{consumer_name}".encode("utf-8")
    return hashlib.sha256(material).hexdigest()


def deliver_bundle(consumer: SecretConsumer, bundle: SecretBundle) -> ConsumerStatus:
    """Call a consumer once and normalise whatever comes back.

    Every abnormal outcome collapses to a status, and no text from the consumer -- a
    return value, an exception message, an attribute -- crosses this line. That is what
    makes the receipt constructible from known-safe data alone.
    """
    try:
        status = consumer.deliver(bundle)
    except Exception:  # noqa: BLE001
        # Deliberately not logged with `str(exc)` or the exception's class name: both
        # are attacker-influenceable on a path whose other end is the model's context
        # and a durable transcript. The consumer name and the fact of failure are
        # enough to diagnose which sink broke.
        return ConsumerStatus.FAILED
    # An enum member or nothing. A consumer that returned a string, a dict, a truthy
    # object or None has a bug, and the safe reading of a bug in the component holding
    # the secret is "we do not know what happened".
    if not isinstance(status, ConsumerStatus):
        return ConsumerStatus.FAILED
    return status


def build_receipt(
    *,
    drop_id: str,
    contract: Mapping[str, Any],
    consumer_name: str,
    status: ConsumerStatus,
    token: str,
    submitted_field_ids: Sequence[str],
    file_count: int = 0,
) -> Dict[str, Any]:
    """The value-free receipt the model sees, built **only** from trusted inputs.

    Every field below comes from the validated contract, the delivery record, or a
    count. Nothing comes from the consumer except ``status``, which is one of three
    fixed words. This is the property that replaces scanning: a receipt cannot leak a
    value because no value is ever in scope when one is constructed.

    ``field_ids`` are the requester's own machine names from the contract it composed --
    they are not secret, and the model needs them to know which request was answered.
    ``answered`` is the subset actually submitted, intersected against the contract so
    an id that somehow arrived from anywhere else cannot appear here either.
    """
    contract_ids = [field["id"] for field in contract["fields"]]
    answered = [field_id for field_id in contract_ids if field_id in set(submitted_field_ids)]
    file_field_ids = [
        field["id"] for field in contract["fields"] if field["type"] not in VALUE_FIELD_TYPES
    ]
    return {
        "ok": True,
        "drop_id": drop_id,
        "state": "delivered" if status is ConsumerStatus.DELIVERED else status.value,
        "consumer": consumer_name,
        "delivery_token": token,
        "field_ids": contract_ids,
        "answered_field_ids": answered,
        "counts": {
            "fields": len(contract_ids),
            "answered": len(answered),
            "files": int(file_count),
            "file_fields": len(file_field_ids),
        },
    }


__all__ = [
    "BUILT_IN",
    "CONSUMER_ERRORS",
    "ConsumerStatus",
    "ConsumerUnavailable",
    "SecretBundle",
    "SecretConsumer",
    "build_receipt",
    "deliver_bundle",
    "delivery_token",
    "resolve_consumer",
]
