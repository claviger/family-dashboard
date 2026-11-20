A pill-shaped, 48px-tall button in Figtree 600. `.btn-primary` is a solid `brand` fill with `on-fill` text: use one per view for the main action (Save, Add). The default `.btn` is outlined with a 2px `line-strong` edge; `.btn-quiet` has no edge, for low-priority actions like Discard.

**You provide:** a `<button type="button">` (or `<a class="btn">`) with a verb label.

- Toggle buttons (Week, Month) set `aria-pressed`; the pressed one is tinted `brand-soft` with a `brand` edge and text.
- While a request is out use `aria-disabled="true"`, not `disabled`: it dims but stays focusable.
- `.btn-inverse` is only for use on the dark Save bar.
- Don't put two primaries side by side or tint a button with `danger`.
