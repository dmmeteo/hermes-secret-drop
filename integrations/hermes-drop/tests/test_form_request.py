"""The form descriptor, producer side -- the twin of ``test/form-request.test.js``.

The two files run the same case table on purpose. The broker is the authority and this
side is a pre-check, so a rule only one of them enforces is not a safety hole: it is
worse in a quieter way. A rule the plugin enforces and the broker does not is a
restriction nobody can see in the protocol; a rule the broker enforces and the plugin
does not is a model told "invalid_request" only after the round trip, with no idea
which of six rules it broke.

Two properties carry most of the weight here, and neither is about this module's own
correctness:

  - **nothing is silently repaired.** A value that breaks a rule comes back as a
    refusal the model can act on, never as a quietly different string. Two spaces are
    not one space, and a clamped exact count is a different request from the one made;
  - **the bounds are code points.** Someone writing Ukrainian, or anything outside the
    BMP, must not get half the allowance an ASCII writer gets.

Characters that cannot be seen are written as escapes rather than pasted, so a reader
can tell what a case actually contains and an editor cannot silently drop it.
"""

from __future__ import annotations

import pytest

from conftest import load_plugin_package

# Bound at import time rather than through a fixture, which is the convention in the
# neighbouring files. The reason is mechanical: the bounds below are used to build
# `pytest.mark.parametrize` cases and by the two module-level helpers, and both are
# evaluated while this module is being imported -- before any fixture could run. The
# package is loaded exactly the way core loads it either way (see conftest).
_form_request = load_plugin_package().drop.form_request

FORM_PROTOCOL = _form_request.FORM_PROTOCOL
FormRefused = _form_request.FormRefused
MAX_DESCRIPTION_CHARS = _form_request.MAX_DESCRIPTION_CHARS
MAX_LABEL_CHARS = _form_request.MAX_LABEL_CHARS
REFUSAL_REASONS = _form_request.REFUSAL_REASONS
broker_enforces_descriptor = _form_request.broker_enforces_descriptor
build_form_request = _form_request.build_form_request
validate_form_request = _form_request.validate_form_request

RLO = "\u202e"  # RIGHT-TO-LEFT OVERRIDE
RLE = "\u202b"  # RIGHT-TO-LEFT EMBEDDING
RLM = "\u200f"  # RIGHT-TO-LEFT MARK
NBSP = "\u00a0"
ZWSP = "\u200b"
LS = "\u2028"  # LINE SEPARATOR
PS = "\u2029"  # PARAGRAPH SEPARATOR
ASTRAL = "\U0001f642"


def check(form, *, payload_kind="files", max_files=5):
    return validate_form_request(form, payload_kind=payload_kind, max_files=max_files)


def refusal(form, **kwargs) -> str:
    with pytest.raises(FormRefused) as caught:
        check(form, **kwargs)
    return caught.value.reason


# --- absence ----------------------------------------------------------------------


def test_absent_descriptor_is_accepted_and_produces_nothing():
    """The backward-compatible path every existing caller takes."""
    assert check(None, payload_kind="universal") is None


def test_empty_descriptor_is_refused_rather_than_read_as_absence():
    # `{}` is a caller that built a descriptor and filled in nothing.
    assert refusal({}) == "empty_form"


@pytest.mark.parametrize("bad", ["a label", 42, True, [], ("label",)])
def test_non_object_descriptor_is_refused(bad):
    assert refusal(bad) == "not_an_object"


# --- keys -------------------------------------------------------------------------


@pytest.mark.parametrize("form", [{"title": "Staging"}, {"label": "Staging", "html": "<b>x</b>"}])
def test_unknown_key_is_refused(form):
    # A caller sending a field this schema does not implement believes something about
    # the form that is not true, and ignoring it lets that belief survive.
    assert refusal(form) == "unknown_key"


def test_every_refusal_reason_is_inside_the_published_set():
    # The reason reaches the model and from there durable state: closed vocabulary,
    # and never the offending input.
    cases = [
        ({}, {}),
        ({"nope": 1}, {}),
        ({"label": ""}, {}),
        ({"label": "x" * (MAX_LABEL_CHARS + 1)}, {}),
        ({"description": RLO}, {}),
        ({"description": "x" * (MAX_DESCRIPTION_CHARS + 1)}, {}),
        ({"expect_files": 0}, {}),
        ({"expect_files": 2}, {"payload_kind": "text"}),
        ({"expect_files": 9}, {}),
    ]
    for form, kwargs in cases:
        with pytest.raises(FormRefused) as caught:
            check(form, **kwargs)
        assert caught.value.reason in REFUSAL_REASONS
        assert caught.value.reason.replace("_", "").isalpha()


def test_the_detail_sentence_names_the_rule_and_never_the_value():
    secretish = "CORRECT-HORSE-BATTERY-STAPLE"
    with pytest.raises(FormRefused) as caught:
        check({"label": f"{secretish}  {secretish}"})  # double space
    assert caught.value.reason == "bad_label"
    assert secretish not in caught.value.detail


# --- label and description text rules ---------------------------------------------


def test_ordinary_copy_is_accepted_in_any_script():
    accepted = check(
        {
            "label": "Staging deployment config",
            "description": "Upload the two configuration files for the staging deployment.",
        }
    )
    assert accepted["label"] == "Staging deployment config"

    # The model may write in the conversation's language; only the static UI chrome is
    # English. The rules are categorial, not alphabetic.
    ukrainian = "Вставте токен доступу до стейджингу."
    assert check({"description": ukrainian})["description"] == ukrainian


def test_the_bound_is_counted_in_code_points_not_utf16_units():
    # The property that makes the bound fair. This is where a naive port breaks: a
    # JavaScript `.length` counts an astral character as two.
    exactly = "a" + ASTRAL * (MAX_LABEL_CHARS - 1)
    assert len(exactly) == MAX_LABEL_CHARS
    assert check({"label": exactly})["label"] == exactly

    assert refusal({"label": "a" + ASTRAL * MAX_LABEL_CHARS}) == "label_too_long"


def test_each_bound_refuses_at_one_code_point_past_it():
    assert check({"label": "a" * MAX_LABEL_CHARS})["label"]
    assert refusal({"label": "a" * (MAX_LABEL_CHARS + 1)}) == "label_too_long"
    assert check({"description": "a" * MAX_DESCRIPTION_CHARS})["description"]
    assert refusal({"description": "a" * (MAX_DESCRIPTION_CHARS + 1)}) == "description_too_long"


def test_length_is_measured_before_the_character_classes():
    # Both languages test the bound first, so an over-long string that ALSO contains a
    # bidi override reports `too_long` rather than `bad`. Pinned because it is exactly
    # the kind of ordering a reimplementation gets subtly wrong.
    assert refusal({"label": "a" * MAX_LABEL_CHARS + RLO}) == "label_too_long"


@pytest.mark.parametrize("hostile", [RLO + "eslaf", "Paste the" + RLE + " token", "a" + RLM + "b"])
def test_bidi_overrides_are_refused(hostile):
    # Copy that can reverse its own rendering can make one sentence read as another
    # beside the input a person is about to paste a credential into.
    assert refusal({"description": f"Upload {hostile}"}) == "bad_description"


@pytest.mark.parametrize(
    "value",
    ["Upload\nboth", "Upload\tboth", "Upload\x0bboth", "a\x00b", f"Upload{LS}both", f"Upload{PS}both", f"Upload{ZWSP}both"],
)
def test_control_characters_and_line_breaks_are_refused(value):
    # Single-paragraph copy only: a newline is a layout the page never has to survive.
    assert refusal({"description": value}) == "bad_description"


@pytest.mark.parametrize(
    "value", [f"Staging{NBSP}config", " Staging config", "Staging config ", "Staging  config"]
)
def test_exotic_whitespace_padding_and_double_spaces_are_refused_not_repaired(value):
    # Refused rather than collapsed: a repaired string is a different string from the
    # one the caller composed, and repairing it here and differently elsewhere is how
    # the two sides stop agreeing.
    assert refusal({"label": value}) == "bad_label"


@pytest.mark.parametrize("empty", ["", "   ", "...", "—"])
def test_copy_that_says_nothing_is_refused(empty):
    assert refusal({"label": empty}) == "bad_label"


@pytest.mark.parametrize("bad", [42, ["a"], {"a": 1}, None])
def test_non_string_label_or_description_is_refused(bad):
    if bad is None:
        # `None` means "not supplied" at the tool surface, so it is only reachable as
        # an explicit wire value -- which is a caller sending a field it does not
        # understand, and is refused as such.
        assert refusal({"description": None}) == "bad_description"
        return
    assert refusal({"label": bad}) == "bad_label"
    assert refusal({"description": bad}) == "bad_description"


def test_markup_is_carried_through_unaltered():
    # Markup is not refused -- it is meaningless, because the page writes textContent
    # and builds no node from it. The validator's job is to pass the characters along
    # unchanged, neither escaped nor stripped.
    hostile = "<img src=x onerror=alert(1)> please paste it"
    assert check({"description": hostile})["description"] == hostile


# --- expect_files -----------------------------------------------------------------


def test_exact_count_inside_the_ceiling_is_accepted():
    assert check({"expect_files": 2}, max_files=5)["expect_files"] == 2


@pytest.mark.parametrize("kind", ["text", "universal"])
def test_exact_count_is_meaningful_only_on_a_files_drop(kind):
    # Exactness is a claim about a request whose shape is known; a universal drop is by
    # definition one whose shape is not.
    assert refusal({"expect_files": 2}, payload_kind=kind) == "expect_files_not_allowed"


def test_exact_count_above_the_ceiling_is_refused_not_clamped():
    assert refusal({"expect_files": 9}, max_files=5) == "expect_files_too_large"
    assert refusal({"expect_files": 3}, max_files=2) == "expect_files_too_large"
    assert check({"expect_files": 2}, max_files=2)["expect_files"] == 2


@pytest.mark.parametrize("bad", [0, -1, 1.5, "2", True, None])
def test_unusable_counts_are_refused(bad):
    if bad is None:
        pytest.skip("None means absent at this seam; covered by the absence tests")
    assert refusal({"expect_files": bad}) == "bad_expect_files"


def test_absent_count_leaves_the_upper_bound_alone():
    # No expectation means the drop's existing ceiling. It must not invent exactness.
    assert "expect_files" not in check({"description": "Upload whatever the deploy needs."})


# --- the flat tool surface -> the one wire object ---------------------------------


def test_build_returns_nothing_when_the_model_supplied_nothing():
    assert build_form_request(payload_kind="universal") is None


def test_build_assembles_only_the_arguments_that_were_given():
    built = build_form_request(
        description="Upload the two staging config files.",
        expect_files=2,
        payload_kind="files",
        max_files=5,
    )
    assert built == {"description": "Upload the two staging config files.", "expect_files": 2}


def test_build_refuses_on_the_same_terms_as_the_wire_validator():
    with pytest.raises(FormRefused) as caught:
        build_form_request(expect_files=2, payload_kind="universal")
    assert caught.value.reason == "expect_files_not_allowed"


# --- the old-broker guard ----------------------------------------------------------


@pytest.mark.parametrize(
    "created, expected",
    [
        ({"ok": True, "form_protocol": FORM_PROTOCOL}, True),
        ({"ok": True, "form_protocol": FORM_PROTOCOL + 1}, True),
        ({"ok": True, "form_protocol": 0}, False),
        ({"ok": True, "form_protocol": True}, False),
        ({"ok": True, "form_protocol": "1"}, False),
        ({"ok": True}, False),
        (None, False),
    ],
)
def test_absence_of_the_capability_means_cannot(created, expected):
    # A broker that predates the descriptor accepts the key by ignoring it: it would
    # mint a drop, render the old generic page, and take any file count at all. Unknown
    # is not "probably fine" when the user would be asked the wrong question.
    assert broker_enforces_descriptor(created) is expected
