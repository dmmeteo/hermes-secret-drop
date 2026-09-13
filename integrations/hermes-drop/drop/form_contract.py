"""The declarative form contract, producer side.

The twin of ``src/form-contract.js``. That one is the authority -- it runs in the
broker, and nothing reaches a browser or a consumer without passing it. This one
exists for the reason ``drop/form_request.py`` gives about its own schema: to refuse
**before a drop exists**, and to tell the model which rule it broke.

Both matter. A contract the broker would refuse must not cost a handoff on its way to
being refused -- there is no destroy op to take one back, and the caller would be left
holding a link to a form that cannot be rendered. And a refusal that reached the model
as ``invalid_request`` and nothing else would leave it guessing at which of twenty
rules it broke, on a structure it is expected to compose.

What a contract is: an ordered list of fields, each with a stable machine id, a
concrete human label, and one of five types. Composition, not presets -- there is no
"login form" and no "API key form", only fields and an order, which is why the type
set is small and closed.

What it is not: a destination, and not a choice of how the answers come back. Whether
a submission goes to the model or to an authorized no-model consumer is *derived* from
the field types by :func:`delivery_for` and cannot be expressed by a caller at all.

Canonicalization is the other half of this module's job, and it is the half that has
to be exact: the digest of :func:`canonicalize` is bound into the HPKE ``info`` the
browser seals under, so a byte of disagreement between this file and the JavaScript is
a drop that can never be opened. The two are held to one shared fixture table
(``test/form-contract.test.js``, ``tests/test_form_contract.py``) including non-BMP
Unicode, combining marks and booleans.
"""

from __future__ import annotations

import hashlib
import json
import re
from typing import Any, Dict, List, Optional, Sequence, Tuple

from .outbound_payload import display_text_problem

#: The contract revision. A change to the shape raises this rather than reusing it.
FORM_CONTRACT_VERSION = 1

#: The ``form_protocol`` floor a contract needs. ``form_request.FORM_PROTOCOL`` is 1 --
#: the floor the *legacy* descriptor needs -- and the two are deliberately different
#: numbers for the same advertised field, because a client sending a legacy descriptor
#: is happy with any broker at 1 or above and one sending a contract needs 2.
FORM_CONTRACT_PROTOCOL = 2

MAX_FIELDS = 8
MAX_TITLE_CHARS = 60
MAX_LABEL_CHARS = 40
MAX_DESCRIPTION_CHARS = 300
MAX_FIELD_ID_CHARS = 32
MAX_FILES_PER_FIELD = 5
MAX_CONTRACT_BYTES = 4096
MAX_CONTRACT_DEPTH = 8

#: Lowercase ASCII, digits and underscore, starting with a letter. Not style: it is
#: what makes a dangerous key unreachable by construction rather than by a filter.
#: ``__proto__`` cannot match, and the wire format never keys an object by a field id
#: at all, so this is one of two independent defences.
FIELD_ID_PATTERN = re.compile(r"^[a-z][a-z0-9_]{0,31}$")

#: Ids that match the grammar but name something on ``Object.prototype``. Denied for
#: parity with the JavaScript, which is the side where it would matter.
DENIED_FIELD_IDS: Tuple[str, ...] = ("constructor", "prototype")

FIELD_TYPES: Tuple[str, ...] = ("text", "email", "textarea", "secret", "files")
SECRET_FIELD_TYPES: Tuple[str, ...] = ("secret",)
VALUE_FIELD_TYPES: Tuple[str, ...] = ("text", "email", "textarea", "secret")

#: Per-value ceilings, in UTF-8 *bytes* -- the unit the wire and the AEAD count in.
MAX_VALUE_BYTES: Dict[str, int] = {
    "text": 512,
    "email": 512,
    "textarea": 8192,
    "secret": 4096,
}

#: The closed refusal vocabulary. Codes, never prose and never the offending input: a
#: refusal is a tool result, it reaches the model's context and from there durable
#: session state.
FORM_CONTRACT_REASONS: Tuple[str, ...] = (
    "bad_description",
    "bad_field",
    "bad_field_id",
    "bad_files_bounds",
    "bad_label",
    "bad_required",
    "bad_title",
    "bad_type",
    "bad_version",
    "contract_too_large",
    "denied_field_id",
    "description_too_long",
    "duplicate_field_id",
    "files_over_budget",
    "label_too_long",
    "no_fields",
    "not_an_object",
    "title_too_long",
    "too_many_fields",
    "unknown_key",
)


class FormContractRejected(Exception):
    """A contract that will not be minted, carrying a code from the closed set."""

    def __init__(self, reason: str) -> None:
        # Unreachable except by editing this module: every raise passes a literal. A
        # reason outside the published set would reach a caller with no branch for it.
        if reason not in FORM_CONTRACT_REASONS:
            raise AssertionError(f"undeclared refusal reason: {reason}")
        super().__init__(reason)
        self.reason = reason


def _refuse(reason: str) -> "FormContractRejected":
    return FormContractRejected(reason)


def _is_mapping(value: Any) -> bool:
    return isinstance(value, dict)


def _is_bool(value: Any) -> bool:
    return value is True or value is False


def _is_count(value: Any, minimum: int, maximum: int) -> bool:
    # ``bool`` is an ``int`` in Python, and a ``True`` reaching a count field is a
    # caller mistake either way -- checked explicitly so it is never read as 1.
    if isinstance(value, bool) or not isinstance(value, int):
        return False
    return minimum <= value <= maximum


def _keys_within(value: Any, required: Sequence[str], optional: Sequence[str]) -> bool:
    if not _is_mapping(value):
        return False
    known = set(required) | set(optional)
    if not set(value).issubset(known):
        return False
    return all(key in value for key in required)


def _depth_of(value: Any, depth: int = 1) -> int:
    if depth > MAX_CONTRACT_DEPTH:
        return depth
    if isinstance(value, list):
        return max((_depth_of(item, depth + 1) for item in value), default=depth)
    if isinstance(value, dict):
        return max((_depth_of(item, depth + 1) for item in value.values()), default=depth)
    return depth


def utf8_length(value: str) -> int:
    return len(value.encode("utf-8"))


def is_secret_field_type(field_type: str) -> bool:
    return field_type in SECRET_FIELD_TYPES


def has_secret_field(contract: Dict[str, Any]) -> bool:
    return any(is_secret_field_type(field["type"]) for field in contract["fields"])


def delivery_for(contract: Dict[str, Any], consumer: Optional[str] = None) -> Dict[str, Any]:
    """The delivery contract, derived from the field types alone.

    This is the whole of "a tool argument must not be able to downgrade the
    restriction by choosing a public result type": there is no argument. A form
    containing a secret goes to an authorized consumer or it is not minted; a form
    containing none takes the ordinary Hermes path.
    """
    if not has_secret_field(contract):
        return {"mode": "model", "consumer": None}
    return {"mode": "consumer", "consumer": consumer}


def _validate_field(raw: Any, seen: set) -> Dict[str, Any]:
    if not _is_mapping(raw):
        raise _refuse("bad_field")

    # The type is read first because it decides which key set applies. A ``text``
    # field carrying ``min_files`` is a caller that believes something untrue about
    # it, and is refused rather than tidied up.
    field_type = raw.get("type")
    if not isinstance(field_type, str) or field_type not in FIELD_TYPES:
        raise _refuse("bad_type")
    is_files = field_type == "files"
    optional = ("required", "min_files", "max_files") if is_files else ("required",)
    if not _keys_within(raw, ("id", "type", "label"), optional):
        raise _refuse("unknown_key")

    field_id = raw.get("id")
    if not isinstance(field_id, str) or not FIELD_ID_PATTERN.match(field_id):
        raise _refuse("bad_field_id")
    if field_id in DENIED_FIELD_IDS:
        raise _refuse("denied_field_id")
    # Uniqueness is on the id and only on the id. Two groups captioned "Log files" are
    # a legitimate form; two fields both called ``logs`` are an ambiguous one.
    if field_id in seen:
        raise _refuse("duplicate_field_id")
    seen.add(field_id)

    label_problem = display_text_problem(raw.get("label"), max_chars=MAX_LABEL_CHARS)
    if label_problem == "too_long":
        raise _refuse("label_too_long")
    if label_problem:
        raise _refuse("bad_label")

    # Absent means optional. Filled in explicitly rather than left out, because the
    # canonical form has to be the *effective* contract for the digest to mean anything.
    required = False
    if "required" in raw:
        if not _is_bool(raw["required"]):
            raise _refuse("bad_required")
        required = raw["required"]

    field: Dict[str, Any] = {
        "id": field_id,
        "type": field_type,
        "label": raw["label"],
        "required": required,
    }
    if not is_files:
        return field

    # One file unless the caller says otherwise: the commonest ask, and a default that
    # can never silently admit more than was intended.
    min_files = 1
    max_files = 1
    if "max_files" in raw:
        if not _is_count(raw["max_files"], 1, MAX_FILES_PER_FIELD):
            raise _refuse("bad_files_bounds")
        max_files = raw["max_files"]
    if "min_files" in raw:
        if not _is_count(raw["min_files"], 1, MAX_FILES_PER_FIELD):
            raise _refuse("bad_files_bounds")
        min_files = raw["min_files"]
    elif max_files < min_files:
        min_files = max_files
    if min_files > max_files:
        raise _refuse("bad_files_bounds")

    field["min_files"] = min_files
    field["max_files"] = max_files
    return field


def validate_form_contract(
    contract: Any, *, max_files: Optional[int] = None
) -> Optional[Dict[str, Any]]:
    """Validate one contract, returning the **effective** contract or ``None``.

    ``None`` means absence -- the backward-compatible path every existing caller
    takes. Anything malformed raises :class:`FormContractRejected` with a code.

    The returned contract carries every default filled in and nothing the caller wrote
    altered. Defaults are not "silent repair": a repair changes a value the caller
    chose, while a default supplies one it declined to choose, and determinism needs
    the effective contract rather than the abbreviation that was typed.
    """
    if contract is None:
        return None
    if not _is_mapping(contract):
        raise _refuse("not_an_object")
    # Checked before the walk: a hostile structure must cost a depth probe, not a
    # traversal.
    if _depth_of(contract) > MAX_CONTRACT_DEPTH:
        raise _refuse("unknown_key")

    if not _keys_within(contract, ("version", "fields"), ("title", "description")):
        raise _refuse("unknown_key")
    if contract.get("version") != FORM_CONTRACT_VERSION or _is_bool(contract.get("version")):
        raise _refuse("bad_version")

    accepted: Dict[str, Any] = {"version": FORM_CONTRACT_VERSION}

    if "title" in contract:
        problem = display_text_problem(contract["title"], max_chars=MAX_TITLE_CHARS)
        if problem == "too_long":
            raise _refuse("title_too_long")
        if problem:
            raise _refuse("bad_title")
        accepted["title"] = contract["title"]

    if "description" in contract:
        problem = display_text_problem(contract["description"], max_chars=MAX_DESCRIPTION_CHARS)
        if problem == "too_long":
            raise _refuse("description_too_long")
        if problem:
            raise _refuse("bad_description")
        accepted["description"] = contract["description"]

    fields = contract.get("fields")
    if not isinstance(fields, list):
        raise _refuse("bad_field")
    if len(fields) == 0:
        raise _refuse("no_fields")
    if len(fields) > MAX_FIELDS:
        raise _refuse("too_many_fields")

    seen: set = set()
    accepted["fields"] = [_validate_field(raw, seen) for raw in fields]

    # An all-optional form is legal. What an empty *submission* means is defined at
    # submit time, not by refusing to build the form -- a form of optional questions is
    # a real thing to ask, and refusing it would be the engine deciding for the
    # requester what a reasonable request looks like.

    budget = MAX_FILES_PER_FIELD if max_files is None else max_files
    asked = sum(f["max_files"] for f in accepted["fields"] if f["type"] == "files")
    if asked > budget:
        raise _refuse("files_over_budget")

    # Bound the whole, not only the parts: a contract every field of which is legal
    # must still fit the 4096-byte control line it has to travel inside.
    if utf8_length(canonicalize(accepted, delivery_for(accepted, None))) > MAX_CONTRACT_BYTES:
        raise _refuse("contract_too_large")

    return accepted


def canonicalize(contract: Dict[str, Any], delivery: Dict[str, Any]) -> str:
    """The exact bytes the digest is taken over.

    Hand-built in a fixed key order rather than dumped from the object, for the reason
    ``canonicalize_outbound_payload`` gives: determinism is the whole job, and a
    serializer that reordered a key would silently change an identity bound into the
    AEAD. ``json.dumps`` is used only for *string escaping*, with ``ensure_ascii=False``
    so a non-BMP character is emitted raw exactly as ``JSON.stringify`` emits it.

    An absent ``title`` or ``description`` is absent from the canonical form -- never
    ``null`` -- so "no description" has exactly one spelling.
    """

    def s(value: str) -> str:
        return json.dumps(value, ensure_ascii=False)

    parts = ['{"version":', json.dumps(contract["version"])]
    if "title" in contract:
        parts.append(',"title":' + s(contract["title"]))
    if "description" in contract:
        parts.append(',"description":' + s(contract["description"]))
    parts.append(',"fields":[')
    rendered: List[str] = []
    for field in contract["fields"]:
        head = (
            "{" + '"id":' + s(field["id"])
            + ',"type":' + s(field["type"])
            + ',"label":' + s(field["label"])
            + ',"required":' + ("true" if field["required"] else "false")
        )
        if field["type"] != "files":
            rendered.append(head + "}")
        else:
            rendered.append(
                head + ',"min_files":' + str(field["min_files"])
                + ',"max_files":' + str(field["max_files"]) + "}"
            )
    parts.append(",".join(rendered))
    parts.append("]")
    consumer = delivery["consumer"]
    parts.append(
        ',"delivery":{"mode":' + s(delivery["mode"]) + ',"consumer":'
        + ("null" if consumer is None else s(consumer)) + "}}"
    )
    return "".join(parts)


def contract_digest(contract: Dict[str, Any], delivery: Dict[str, Any]) -> str:
    """SHA-256 of the canonical contract, lowercase hex. The identity bound into ``info``."""
    return hashlib.sha256(canonicalize(contract, delivery).encode("utf-8")).hexdigest()


def supports_form_contract(created: Any) -> bool:
    """Whether a broker's ``create`` response says it speaks the declarative contract.

    Absence means "cannot", never "probably fine" -- the same pre-flight rule
    ``file_claim_protocol`` follows. A broker without this field would accept the key
    by ignoring it, mint a drop, serve a page with no questions on it, and the
    requester would never find out.
    """
    if not isinstance(created, dict):
        return False
    revision = created.get("form_protocol")
    if isinstance(revision, bool) or not isinstance(revision, int):
        return False
    return revision >= FORM_CONTRACT_PROTOCOL


__all__ = [
    "DENIED_FIELD_IDS",
    "FIELD_ID_PATTERN",
    "FIELD_TYPES",
    "FORM_CONTRACT_PROTOCOL",
    "FORM_CONTRACT_REASONS",
    "FORM_CONTRACT_VERSION",
    "MAX_CONTRACT_BYTES",
    "MAX_CONTRACT_DEPTH",
    "MAX_DESCRIPTION_CHARS",
    "MAX_FIELDS",
    "MAX_FIELD_ID_CHARS",
    "MAX_FILES_PER_FIELD",
    "MAX_LABEL_CHARS",
    "MAX_TITLE_CHARS",
    "MAX_VALUE_BYTES",
    "SECRET_FIELD_TYPES",
    "VALUE_FIELD_TYPES",
    "FormContractRejected",
    "canonicalize",
    "contract_digest",
    "delivery_for",
    "has_secret_field",
    "is_secret_field_type",
    "supports_form_contract",
    "utf8_length",
    "validate_form_contract",
]
