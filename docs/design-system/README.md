Family Dashboard is the warm center of a household: one page where everyone sees the week, what needs doing, who has which chore and where the money went. It should feel like a kitchen noticeboard, not a work tool. Paper-warm surfaces, a clay accent, a friendly serif for names and numbers, soft rounded shapes, and one color for each part of home life.

## Content fundamentals

- Speak like a kind housemate. Short, plain, second person: "Your chores", "Nothing planned. Enjoy it.", "All done for today."
- Say what happened and what to do, with no blame and no exclamation marks: "That didn't save. Try again." Praise is quiet: "Done: Empty the dishwasher."
- Sentence case everywhere. Panel names are one word: Calendar, To-do, Chores, Spend, Savings. Buttons are verbs: Save, Claim, Add.
- Name people, not accounts: "Maya's soccer", "Up for grabs", "Dad claimed this".
- Money has the symbol, two decimals and tabular numerals. Dates are relative when close ("Today", "Tomorrow", "Overdue since Tuesday") and exact when far.
- No emoji. Warmth comes from wording, color and shape.

## Visual foundations

- **Ground.** Set pages on `canvas` and lift every card, dialog and field onto `surface`. Use `sunken` for recessed things only: tab tracks, bar tracks, neutral chips.
- **Color has jobs.** `brand` (clay) is the one action color: primary button, today, selected. Each panel owns a hue: Calendar `calendar` (blue), To-do `todo` (plum), Chores `chores` (amber), Spend `spend` (green), Savings `savings` (teal). A panel color appears only in that panel's icon badge, checkboxes, bars and chips, always on its `-soft` tint or on `surface`. Each family member picks one of `person-1` to `person-6`, shown on their avatar and on their events. `danger` (cranberry) is for errors and overdue only.
- **Never color alone.** Overdue says "Overdue", errors are sentences, today is a filled number as well as a tint, a selected tab is a raised segment, a checked box has a check.
- **Text on fills** is `on-fill`. Text on any `-soft` tint is `ink`, `muted` or that tint's own color.
- **Type.** EB Garamond (`display`) for the family name, titles, card headings and big figures at weight 600; Figtree (`sans`) for everything else. Use `display` once per page, `heading` for card titles, `subhead` for groups inside a card, `body` for items, `small` for dates and labels, `caption` for chips. Money always uses tabular numerals.
- **Shape.** Everything is round. Cards and dialogs `radius-lg`, day tiles and notices `radius-md`, inputs and event blocks `radius-sm`, and buttons, chips, tabs, avatars and bars `radius-pill`. Nest radii: an inner shape's radius is smaller than its container's.
- **Depth.** Cards float on `canvas` with `shadow-card`, no border. Only the Save bar and dialogs use `shadow-lift`. Hairlines in `line` separate rows inside a card.
- **Spacing.** Cards pad `space-5` (24px) and sit `space-5` apart; rows pad `space-3`; page padding is `space-4` on phones and `space-6` on tablets and wall displays. Be generous: whitespace is the main decoration.
- **Touch.** Anything pressable is at least `touch-target` (48px) tall. Checkboxes are 28px circles with a 48px hit area. The app is used on phones, tablets and a kitchen display.
- **Focus.** A solid 3px `focus` ring, offset 2px, on every control. Input borders are `line-strong` (2px), turning `focus` colored when focused.
- **Layout.** A card grid with 300px minimum columns, up to four columns on a wall display; the week view is seven tiles, collapsing to a day-by-day list on phones. Today's tile is washed `brand-soft`.
- **Motion.** Gentle and short: 150ms ease on hover and press, a quiet fade when a view reloads. Respect reduced motion; the app never needs motion to be understood.

## Iconography

Icons are simple rounded line shapes on a 24px grid: 2px stroke, round caps and joins, `currentColor`, no fills. The five panel icons are a calendar page (Calendar), a circled check (To-do), a house (Chores), a wallet (Spend) and a stack of coins (Savings), plus chevron and plus. Place each panel icon in a 44px circular badge: `-soft` tint behind, the panel color on the icon. Use inline SVG so it inherits color. The shapes in these previews were drawn for this system; when implementing, an icon set with the same style (Lucide matches it) can replace them. No emoji, no filled or multicolor icons.

## Components

Components are plain CSS classes in `components/bundle.css` that read the tokens: Button, Field, Card, Chip, Avatar, TodoRow, Tabs, Notice, TopBar, CalendarWeek, SpendBars and SaveBar. Copy the markup in each preview. Panel and person colors are set by adding `panel-calendar`, `panel-todo`, `panel-chores`, `panel-spend`, `panel-savings` or `p1` to `p6` to the element.

## Fonts

EB Garamond and Figtree are loaded from Google Fonts by `bundle.css`. The real app self-hosts both variable fonts (`@fontsource-variable/eb-garamond` and `@fontsource-variable/figtree`) so the dashboard works offline on the kitchen display and under its CSP. If they fail to load the stacks fall back to Garamond or Times New Roman and the system sans.

## Accessibility

Every text pair holds 4.5:1 or better in light and dark, including text on each `-soft` tint and `on-fill` on every solid fill. Input and unchecked-checkbox borders (`line-strong`) and the `focus` ring hold 3:1 or better. Status always carries words. Not yet covered: a dedicated high-contrast theme.
