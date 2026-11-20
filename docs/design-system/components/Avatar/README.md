A circle holding a person's first initial in `on-fill` on their chosen color (`person-1` to `person-6`), with a 2px `surface` ring so avatars overlap cleanly. 32px (`avatar-sm`) beside a row, 44px (`avatar-md`, add `.avatar-md`) in the top bar.

**You provide:** a `p1`–`p6` class and the initial. Mark it `aria-hidden`; the name must also appear in text beside it.

- Each member keeps one color everywhere: avatar, calendar events, chore claims.
- `on-fill` on all six colors meets 4.5:1 in both themes.
- Stack with `.avatar-stack` for "who's involved"; show at most three and a "+N" chip after.
- Don't use person colors for status or panels.
