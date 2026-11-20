A pill-shaped segmented control: a `sunken` track holding 40px segments; the current segment is raised on `surface` with `shadow-card` and `ink` text, the others are `muted`.

**You provide:** a `<nav class="tabs">` of links (routes), the current one `aria-current="page"`; or buttons with `aria-selected` for in-page switching.

- Two to four short one-word segments. More than that: use a select.
- The current segment differs by raised surface, text color and weight, never color alone.
- Wraps to a second line on a narrow screen rather than scrolling.
