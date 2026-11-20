The Spend card's headline number (`figure`, tabular numerals) and a breakdown: each category is a name, an amount and a 12px pill bar filled with `spend` on a `sunken` track.

**You provide:** the total as formatted text and a `.bars` list; each `.bar-row` has `.name`, `.amount` and a `.bar-fill` width in percent.

- Every bar has its amount in text; the bar is `aria-hidden` decoration.
- The selected category gets `aria-current="true"`: its name turns `spend` and bold.
- Bars are scaled to the largest category, not to the total.
- Amounts right-align and use tabular numerals.
