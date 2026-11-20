A floating pill that holds the one Save while there are unsaved edits: an `ink` fill with `canvas` text, `shadow-lift`, held 16px above the bottom of the screen. It states the count, then Discard and Save.

**You provide:** the count message, a quiet Discard and an inverse Save (`.btn-inverse`); errors go in the message text in words.

- It inverts the page (dark on light, light on dark) so it reads as separate from the content under it.
- Edited fields are marked in place with a `brand` border and "Changed, not saved"; the bar only summarizes.
- Pad the page's bottom by the bar's height so focused controls are not hidden behind it.
- Along with dialogs, the only element with `shadow-lift`.
