The week view: seven `surface` tiles (`radius-md`, `shadow-card`), each with a day-number circle and weekday. Today's tile is washed `brand-soft` and its number sits in a filled `brand` circle. Events are 48px-tall blocks in the attendee's person color with `on-fill` text: title in 600, time and name underneath.

**You provide:** a `.week` of `.day` tiles (add `.today`) and `.event` buttons with a `p1`–`p6` class; an empty day says "Nothing planned".

- On a phone, replace the seven tiles with a day-by-day list of the same `.day` tiles, stacked.
- An event with several people uses the first person's color and lists the names in text.
- Today is marked by tint, the filled number and a text "Today" in the accessible name, never tint alone.
