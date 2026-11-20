A labeled input, select or textarea. The label sits above in `small` `muted` 600; the control is 48px tall on `surface` with a 2px `line-strong` border and `radius-sm`, which becomes `focus`-colored when focused.

**You provide:** a `<label class="field">` wrapping the text label and the control. Keep control text at 16px.

- Errors: set `aria-invalid="true"` (border turns `danger`) and put a `.field-error` sentence below, linked with `aria-describedby`.
- Unsaved edit: wrap in `.field-edited` (a `brand` border) and show "Changed, not saved" in `.field-edited-note`.
- Never drop the visible label for a placeholder.
