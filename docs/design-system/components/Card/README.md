The Home page card: a `surface` block with `radius-lg`, `shadow-card` and 24px padding. Its head is a link to the panel's drill-down: a 44px circular icon badge in the panel's `-soft` tint, the panel name in `heading`, and a chevron in `muted`. Cards sit in `.card-grid` with 24px gaps.

**You provide:** the panel class (`panel-calendar`, `panel-todo`, `panel-chores` or `panel-spend`) on the card, one `<a class="card-head">` with an inline 24px icon, then the panel's summary.

- One card per panel. The panel color appears only in the badge, the chevron on hover, and controls inside the card (checkboxes, bars, chips).
- A big number uses `.card-figure` (`figure` style, tabular numerals).
- Empty state is a single `muted` sentence in the house voice, never a blank card.
- Don't add a border or a second shadow; don't nest cards.
