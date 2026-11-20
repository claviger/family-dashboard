A rounded message box (`radius-md`) with a 24px icon and one or two plain sentences in `ink`. `.notice` is neutral (`sunken`), `.notice-brand` (`brand-soft`) asks for attention, `.notice-danger` (`danger-soft`, with a `danger` icon) reports a failure.

**You provide:** an inline icon and a sentence in the house voice: what happened, then what to do. Use `role="alert"` on errors.

- The icon and the words carry the meaning; the tint only reinforces it.
- Text stays `ink`, so contrast holds on every tint in both themes.
- No dismiss-everything banners: show one notice, next to what it is about.
