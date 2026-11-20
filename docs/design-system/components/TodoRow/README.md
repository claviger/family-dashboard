One item in a to-do or chore list: a 28px round checkbox (48px hit area), a title with a `small` `muted` sub-line, and an optional chip or avatar on the right. Rows are at least 56px tall, separated by a `line` hairline, with no box around each.

**You provide:** a `.rows` list of `.row` items, set inside a card that has a panel class (`panel-todo` or `panel-chores`) so the checked circle takes that color; a labeled `.check` input; `.row-title` and `.row-sub` text.

- Overdue: `.row-sub.overdue` turns `danger` 600 and says "Overdue since …"; add a `chip-late`.
- Done: the row gets `.done`, the title is `muted` with a strikethrough, and the circle is filled with a check.
- Titles wrap; never truncate them.
- Claimed chores show the claimer's avatar and name in the sub-line.
