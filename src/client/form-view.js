// Drawing a declarative form contract, and reading back what a person typed.
//
// DOM only. Every rule about what a value may be lives in `src/form-contract.js`, which
// the broker runs too; this module decides how a field looks and nothing about whether
// it is acceptable. That separation is the same one `reveal-view.js` keeps on the
// outbound side, and for the same reason: a view that also decided policy would be a
// second place for the policy to be wrong.
//
// Nothing here is ever built from a string. Labels, titles and descriptions arrive as
// untrusted display data composed by a model, and they reach the document only as
// `textContent` on an element created by `createElement`. That prevents markup
// *executing*; it does not prevent copy *misleading*, which is what the bounds and the
// closed key set in the contract module are for.
import { MAX_VALUE_BYTES, isEmailShaped, utf8Length } from '../form-contract.js';

/** The mask a secret field shows until its owner asks to see it. */
const SHOW_LABEL = 'Show';
const HIDE_LABEL = 'Hide';

function element(document, tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

/**
 * One field's control, chosen by type. The id is what the value comes back under and is
 * also what ties the `<label>` to its input, so a screen reader reads the same name the
 * requester chose.
 */
function buildControl(document, field, { onInput }) {
  if (field.type === 'textarea') {
    const control = element(document, 'textarea');
    control.rows = 4;
    control.id = `field-${field.id}`;
    control.addEventListener('input', onInput);
    return control;
  }
  const control = element(document, 'input');
  control.id = `field-${field.id}`;
  // `password` for a secret, so the browser masks it and offers no autofill history;
  // `email` gets the right keyboard on a phone without the browser refusing the value,
  // because shape is checked by our own rule and not by the platform's.
  control.type = field.type === 'secret' ? 'password' : field.type === 'email' ? 'email' : 'text';
  control.autocomplete = 'off';
  control.autocapitalize = 'off';
  control.autocorrect = 'off';
  control.spellcheck = false;
  control.addEventListener('input', onInput);
  return control;
}

/**
 * Renders one contract into `list` and returns a reader.
 *
 * The reader hands back `{ values, files }` as **ordered arrays**, the same shape the
 * container and the broker use. Nothing here builds an object keyed by a field id, so a
 * hostile id has nowhere to land on this side either.
 */
export function renderFormFields({ document, list, contract, onChange = () => {} }) {
  list.textContent = '';
  const entries = [];

  for (const field of contract.fields) {
    const item = element(document, 'li', 'form-field');
    const label = element(document, 'label');
    label.htmlFor = `field-${field.id}`;
    label.textContent = field.label;
    if (!field.required) {
      const optional = element(document, 'span', 'optional');
      optional.textContent = 'optional';
      label.append(optional);
    }
    item.append(label);

    if (field.type === 'files') {
      const zone = element(document, 'button', 'drop-zone');
      zone.type = 'button';
      const wants = field.min_files === field.max_files
        ? `Choose ${field.min_files} file${field.min_files === 1 ? '' : 's'}`
        : `Choose ${field.min_files} to ${field.max_files} files`;
      zone.textContent = `${wants} or drag them here`;
      const input = element(document, 'input');
      input.type = 'file';
      input.multiple = field.max_files > 1;
      input.hidden = true;
      input.id = `field-${field.id}`;
      // Starts hidden and stays hidden until there is something to count: a tally
      // reading zero is not information, it is a row to read past.
      const tally = element(document, 'p', 'meta');
      tally.hidden = true;

      const selected = [];
      const redraw = () => {
        tally.hidden = selected.length === 0;
        if (selected.length > 0) {
          const total = selected.reduce((sum, file) => sum + file.size, 0);
          tally.textContent = `${selected.length} of ${field.max_files} selected · ${formatBytes(total)}`;
        }
        onChange();
      };
      const add = (files) => {
        for (const file of files) {
          if (selected.length >= field.max_files) break;
          selected.push(file);
        }
        redraw();
      };
      zone.addEventListener('click', () => input.click());
      input.addEventListener('change', () => { add([...input.files]); input.value = ''; });
      for (const type of ['dragenter', 'dragover']) {
        zone.addEventListener(type, (event) => { event.preventDefault(); zone.classList.add('drag'); });
      }
      for (const type of ['dragleave', 'drop']) {
        zone.addEventListener(type, (event) => {
          event.preventDefault();
          zone.classList.remove('drag');
          if (type === 'drop') add([...event.dataTransfer.files]);
        });
      }
      item.append(zone, input, tally);
      entries.push({ field, files: selected, control: input });
      list.append(item);
      continue;
    }

    const control = buildControl(document, field, { onInput: onChange });
    if (field.type === 'secret') {
      // A masked field a person cannot check is a field they will mistype. The reveal
      // is a real button with a real accessible name, and it toggles the input's type
      // rather than moving the value anywhere.
      const row = element(document, 'div', 'secret-row');
      const toggle = element(document, 'button', 'ghost');
      toggle.type = 'button';
      toggle.textContent = SHOW_LABEL;
      toggle.setAttribute('aria-label', `${SHOW_LABEL} ${field.label}`);
      toggle.addEventListener('click', () => {
        const shown = control.type === 'text';
        control.type = shown ? 'password' : 'text';
        toggle.textContent = shown ? SHOW_LABEL : HIDE_LABEL;
        toggle.setAttribute('aria-label', `${shown ? SHOW_LABEL : HIDE_LABEL} ${field.label}`);
        control.focus();
      });
      row.append(control, toggle);
      item.append(row);
    } else {
      item.append(control);
    }
    entries.push({ field, control });
    list.append(item);
  }

  return {
    /** `{ values, files }`, ordered, exactly as the container wants them. */
    read() {
      const values = [];
      const files = [];
      for (const entry of entries) {
        if (entry.field.type === 'files') {
          for (const file of entry.files) files.push({ field: entry.field.id, file });
          continue;
        }
        values.push({ field: entry.field.id, value: entry.control.value });
      }
      return { values, files };
    },

    /**
     * The first problem a sender can act on, in the order they would meet it, or null.
     *
     * A convenience for the person at the keyboard and evidence of nothing: the broker
     * re-checks all of this on the decoded plaintext after the AEAD opens, which is the
     * first moment the real values exist. The messages name the field by its *label*,
     * because that is what the person is looking at.
     */
    problem() {
      for (const entry of entries) {
        const { field } = entry;
        if (field.type === 'files') {
          const count = entry.files.length;
          if (count === 0) {
            if (field.required) return `${field.label} needs a file`;
            continue;
          }
          if (count < field.min_files) {
            return `${field.label} needs at least ${field.min_files} files`;
          }
          continue;
        }
        const value = entry.control.value;
        if (field.required && value.trim() === '') return `${field.label} is required`;
        if (utf8Length(value) > MAX_VALUE_BYTES[field.type]) {
          return `${field.label} is too long`;
        }
        if (field.type === 'email' && value !== '' && !isEmailShaped(value)) {
          return `${field.label} does not look like an email address`;
        }
      }
      const answered = entries.some((entry) => (
        entry.field.type === 'files' ? entry.files.length > 0 : entry.control.value !== ''
      ));
      if (!answered) return 'Fill in at least one field before sending';
      return null;
    },

    /** Focus the first control, so a keyboard is already where it needs to be. */
    focusFirst() {
      entries[0]?.control?.focus?.();
    },

    /** Disable everything once a send is in flight; one secure send, no edits. */
    freeze() {
      for (const entry of entries) entry.control.disabled = true;
    },
  };
}
