"""The inbound form descriptor, producer side.

The twin of ``src/form-request.js``. That one is the authority -- it runs in the
broker, and nothing reaches a browser without passing it. This one exists for the
reason ``drop/outbound_payload.py`` gives about its own schema: to refuse **before a
drop exists**, and to tell the model which rule it broke.

Both matter. A descriptor the broker would refuse must not cost a handoff on its way
to being refused, because there is no destroy op to take one back and the caller would
be left holding a link to a form that cannot be rendered. And a refusal that reached
the model as "invalid_request" and nothing else would leave it guessing at which of
six rules it broke, on a field it is expected to compose in prose.

What a descriptor is: optional, bounded, **non-secret** display copy. A label for the
form's heading, one short sentence about what to paste, and -- when the request is
genuinely for a known number of files -- that number. Nothing here is a credential,
nothing here is secret, and nothing here chooses where a link goes.

What it is not: the payload kind. Whether a drop wants text, files or either is
``payload_kind``, which the broker binds into the AEAD. This module never decides the
lane; ``expect_files`` is refused outright on a kind with no file lane rather than
ignored.

The case table in ``tests/test_form_request.py`` is the same one
``test/form-request.test.js`` runs. A rule only one side enforces is a rule a caller
meets inconsistently.
"""

from __future__ import annotations

from typing import Any, Dict, Mapping, Optional, Tuple

from .outbound_payload import display_text_problem

#: A heading for the form: short enough to stay one line on a phone.
MAX_LABEL_CHARS = 80

#: One or two sentences saying what to paste -- not a security essay, and not a place
#: to restate what the page already says about encryption and expiry. The ceiling is
#: what keeps it quiet copy rather than a second document.
MAX_DESCRIPTION_CHARS = 300

#: The closed key set. Mirrors ``FORM_KEYS`` in ``src/form-request.js``.
FORM_KEYS = ("label", "description", "expect_files")

#: The descriptor revision this plugin composes for. A broker that does not advertise
#: ``form_protocol`` at least this high cannot enforce a descriptor -- it would accept
#: the key by ignoring it, render the old generic page and take any file count at all
#: -- so a caller that means "exactly two files" checks this BEFORE posting a link.
FORM_PROTOCOL = 1

#: The closed refusal vocabulary, identical to the JavaScript side's.
REFUSAL_REASONS = (
    "not_an_object",
    "empty_form",
    "unknown_key",
    "bad_label",
    "label_too_long",
    "bad_description",
    "description_too_long",
    "bad_expect_files",
    "expect_files_not_allowed",
    "expect_files_too_large",
)

#: One sentence per reason, for the model. Names the rule, never the value: this text
#: becomes a tool result, which reaches the model's context and from there durable
#: session state, so a message quoting the offending string would put the caller's copy
#: somewhere it was never meant to go.
REASON_HELP: Dict[str, str] = {
    "not_an_object": "the form descriptor must be an object",
    "empty_form": "the form descriptor must set at least one field, or be omitted",
    "unknown_key": "the form descriptor accepts only label, description and expect_files",
    "bad_label": (
        "label must be one line of ordinary text with no double spaces, no padding "
        "and at least one letter or digit"
    ),
    "label_too_long": f"label must be at most {MAX_LABEL_CHARS} characters",
    "bad_description": (
        "description must be one line of ordinary text with no line breaks, no double "
        "spaces, no padding and at least one letter or digit"
    ),
    "description_too_long": f"description must be at most {MAX_DESCRIPTION_CHARS} characters",
    "bad_expect_files": "expect_files must be a whole number of at least 1",
    "expect_files_not_allowed": (
        "expect_files is only meaningful when the request is for files; omit it, or "
        "ask for files mode"
    ),
    "expect_files_too_large": "expect_files must not exceed the number of files the drop accepts",
}


class FormRefused(Exception):
    """A descriptor that must not be sent. Carries a reason code and its sentence."""

    def __init__(self, reason: str) -> None:
        assert reason in REFUSAL_REASONS, f"undeclared refusal reason: {reason}"
        super().__init__(reason)
        self.reason = reason

    @property
    def detail(self) -> str:
        help_text = REASON_HELP.get(self.reason, "")
        return f"{self.reason}" + (f" - {help_text}" if help_text else "")


def build_form_request(
    *,
    label: Any = None,
    description: Any = None,
    expect_files: Any = None,
    payload_kind: str,
    max_files: Optional[int] = None,
) -> Optional[Dict[str, Any]]:
    """Assemble and validate one descriptor from the model's separate arguments.

    Returns the wire object, or ``None`` when the model supplied nothing -- which is
    the backward-compatible path every existing caller takes, and which must not
    manufacture an empty object for the broker to refuse.

    Raises :class:`FormRefused`. The model-facing tool surface is flat (``label``,
    ``description``, ``expect_files`` are separate arguments, because a nested object
    in a tool schema is a thing models get wrong), and the wire shape is one object,
    because on the wire it is one bag of untrusted display data with one trust
    boundary. This function is where the two shapes meet.
    """
    form: Dict[str, Any] = {}
    if label is not None:
        form["label"] = label
    if description is not None:
        form["description"] = description
    if expect_files is not None:
        form["expect_files"] = expect_files
    if not form:
        return None

    validated = validate_form_request(form, payload_kind=payload_kind, max_files=max_files)
    if validated is None:
        # Unreachable: `form` is non-empty, so validation either returns it or raises.
        raise FormRefused("empty_form")
    return validated


def validate_form_request(
    form: Any,
    *,
    payload_kind: str,
    max_files: Optional[int] = None,
) -> Optional[Dict[str, Any]]:
    """Validate one descriptor as it will go on the wire.

    Returns ``None`` for an absent descriptor and otherwise a dict carrying exactly the
    keys that were given. Raises :class:`FormRefused` for anything the schema refuses.
    Never mutates its argument and never returns a value the caller did not write.
    """
    if form is None:
        return None
    if not isinstance(form, Mapping) or isinstance(form, (str, bytes)):
        raise FormRefused("not_an_object")

    keys = list(form.keys())
    # `{}` is not absence: it is a caller that built a descriptor and filled in
    # nothing, which is a mistake worth hearing about rather than a default to swallow.
    if not keys:
        raise FormRefused("empty_form")
    for key in keys:
        if key not in FORM_KEYS:
            raise FormRefused("unknown_key")

    accepted: Dict[str, Any] = {}

    if "label" in form:
        problem = display_text_problem(form["label"], max_chars=MAX_LABEL_CHARS)
        if problem == "too_long":
            raise FormRefused("label_too_long")
        if problem:
            raise FormRefused("bad_label")
        accepted["label"] = form["label"]

    if "description" in form:
        problem = display_text_problem(form["description"], max_chars=MAX_DESCRIPTION_CHARS)
        if problem == "too_long":
            raise FormRefused("description_too_long")
        if problem:
            raise FormRefused("bad_description")
        accepted["description"] = form["description"]

    if "expect_files" in form:
        expected = form["expect_files"]
        # bool is an int subclass; True would silently become "exactly 1 file".
        if isinstance(expected, bool) or not isinstance(expected, int) or expected < 1:
            raise FormRefused("bad_expect_files")
        # Exactness is a claim about a request whose shape is known. A `universal` drop
        # is by definition one whose shape is not -- the sender still chooses the lane
        # -- and a `text` drop has no file lane at all. Both refuse rather than ignore,
        # on the terms `max_files` is already refused on a text drop.
        if payload_kind != "files":
            raise FormRefused("expect_files_not_allowed")
        # Refused, not clamped. `max_files` may narrow silently because a narrowed
        # upper bound is still true; an exact count that were clamped would be a
        # different request from the one that was made.
        if isinstance(max_files, int) and expected > max_files:
            raise FormRefused("expect_files_too_large")
        accepted["expect_files"] = expected

    return accepted


def broker_enforces_descriptor(created: Optional[Mapping[str, Any]]) -> bool:
    """Can the broker that answered *created* actually honour a descriptor?

    Read off the response rather than assumed from this plugin's version, for the
    reason :func:`control_client.supports_outbound_drop` gives at length: the two
    halves ship together in this repo but are installed separately, and a plugin runs
    against whatever broker is deployed.

    Absence means "cannot", because a broker without the capability publishes no field
    at all -- and unknown is not "probably fine" when the alternative is a user shown a
    generic form for a request that named two specific files.
    """
    if not isinstance(created, Mapping):
        return False
    revision = created.get("form_protocol")
    if isinstance(revision, bool) or not isinstance(revision, int):
        return False
    return revision >= FORM_PROTOCOL


__all__ = [
    "FORM_KEYS",
    "FORM_PROTOCOL",
    "FormRefused",
    "MAX_DESCRIPTION_CHARS",
    "MAX_LABEL_CHARS",
    "REASON_HELP",
    "REFUSAL_REASONS",
    "broker_enforces_descriptor",
    "build_form_request",
    "validate_form_request",
]
