# Chore board: design

Status: approved 2026-11-18. This changes the Chores panel (main spec §11) and replaces its "Up for grabs occurrences" model with a board of chores that people claim. Where this document and §11 disagree, this one wins, and §11 gets rewritten to match as part of the work.

## Why

Chores today make an occurrence on each scheduled date, and each occurrence is assigned or up for grabs. A chore with no default assignee doesn't show anywhere until its day arrives, then sits as an Up for grabs item that can go overdue with nobody responsible. What the family wants is a board: every household chore, how often it comes up, and who has it. Unassigned chores are never late. Once someone takes a chore it lands on their to-do list and keeps coming back on schedule until they hand it off.

## Rules

### The board

- Every active chore, whether or not it's assigned.
- Each row shows the title, the frequency ("Every day", "Fridays", "Every 2 weeks on Mon", "Monthly on the 1st", "Every 10 days after it's done", "As needed"), who has it (avatar and name, or Unassigned), and its state:
  - Assigned with an open to-do: "Due Fri" or "Due today", or "Overdue since Fri" in the danger color (with the word, never color alone).
  - Assigned, nothing due yet: "Next: Fri 27".
  - Assigned, as needed: "On their list".
  - Unassigned: nothing. Unassigned chores have no due date and are never late.
- **Sort order:** by how often the chore comes up, most often first. Each frequency gets a period in days, and the board sorts by it, then by title:
  - daily: 1
  - weekly on k weekdays: 7 / k
  - every N weeks on k weekdays: 7N / k
  - monthly: 30
  - every N days after completion: N; every N weeks after completion: 7N
  - as needed: last, after everything else
- Paused and archived chores aren't on the board.

### Frequencies

The existing schedule kinds stay as they are (daily, weekly on chosen weekdays, every N weeks on chosen weekdays counted from the start date's week, monthly on day N or the last day, every N days or weeks after completion). One kind is new: **as needed** (`{ kind: 'none' }`), a chore with no frequency.

The start date stays. It only matters for "every N weeks" (which week counts as week one) and as the earliest date a chore can be due. It defaults to today and the form shows it only for "every N weeks".

### Who can do what

- **Claim:** anyone with the Chores panel can claim an unassigned chore, or take a chore from another person.
- **Release:** a member can put a chore they have back on the board, unassigned.
- **Admins** can also assign any chore to any active user, reassign it, or unassign it.
- **Add:** anyone with the Chores panel can add a chore. A member can leave it unassigned or take it themselves; an admin can also assign it to anyone.
- **Edit, pause, resume, archive:** admins only, as today.
- The existing warning stays: assigning to someone who has neither the Chores nor the To-do panel warns that they'd never see it.

### What being assigned does

A chore's assignment lives on the chore. An assigned chore has at most one open occurrence, and that occurrence carries the to-do (main spec §11.5, unchanged: Chore tag, Todoist chores project, pending/retry/stuck handling, to-do events).

- **On assignment** (claim, take over, admin assign, or added already assigned):
  - If the chore already has an open occurrence (a take-over or reassign), it moves to the new person with its due date unchanged, overdue or not. The old person's to-do is deleted and the new person gets one.
  - Otherwise an occurrence is created right away. Repeating chores: due on the next date the schedule hits, today or later (see "Next due date"). As-needed chores: no due date.
- **Done early** (a repeating chore completed before its due date): nothing new appears until the due date has passed. The day after it, the next occurrence is created, due on the next date the schedule hits from that day.
- **Not done by the due date:** the occurrence stays open, overdue, on their list. Nothing else is created while it's open. When it's finally completed (or skipped), its due date has already passed, so the next occurrence is created right away, due on the next date the schedule hits from today.
- **Skipped** (the to-do deleted, or an admin skip): the same as done for scheduling. History records it as skipped.
- **As needed, completed or skipped:** the chore goes back to the board, unassigned. Nothing new is created.
- **Released or unassigned:** the open occurrence is deleted (not history, since it wasn't done or skipped) and its to-do is deleted. The chore is unassigned.
- **Paused or archived:** as today, the open occurrence and its unfinished to-do are removed. Pausing keeps the assignment, so resuming puts the chore back on the person's list on the next generation run. Archiving clears it.
- **Assignee deactivated:** their chores become unassigned and their open occurrences are removed, as when released.

### Next due date

All dates are family-local, as today.

- **From date F**, the next due date of a repeating chore is:
  - Fixed schedules: the first scheduled date on or after F (and on or after the start date).
  - After completion: the later of F and (the last close date plus the interval). With no close yet, the later of F and the start date.
- **On assignment,** F is today.
- **After an occurrence closes,** F is the day after its due date or today, whichever is later. So a chore done early waits for its due date to pass, and one done late comes back right away.
- The generation job (every 15 minutes and at midnight, as today) creates the occurrence once today has reached F: for each active, assigned, repeating chore with no open occurrence, if today is on or after F, it creates the occurrence due on the next due date from F. It's still safe to repeat (one occurrence per chore per due date) and still creates at most one per chore per run.

### Home tile

In this order, up to 6 rows in total:

1. **Yours, due:** your chores with an open occurrence, overdue ones first and highlighted, each with a checkbox to complete it. These always show, even past 6.
2. **Yours, waiting:** chores you have with nothing due yet, muted, with "Next: Fri 27".
3. **Up for grabs:** the top unassigned chores in board order, each with a Claim button, filling whatever rows are left.

The card says "Nothing on your plate" when you have nothing, and the line summarizing everyone else's chores goes away.

### Chores page

- **Board** (the default tab, replacing Open): the board above, with Claim, Release, and done checkboxes on your own due rows; admins also get Assign. An "Add chore" form is at the top for everyone.
- **History:** unchanged (main spec §11.7). As-needed completions are never "late".
- **Manage** (admins only, the current Chores tab renamed): edit, pause, resume, archive, and the paused and archived lists.

## Data changes

One migration:

- `chores.default_assignee_user_id` becomes `chores.assignee_user_id`: who has the chore now, not a default for future occurrences. Null means unassigned.
- `chores.schedule_type` gains `'as_needed'`, and `schedule` gains `{ kind: 'none' }`.
- `chore_occurrences.due_date` becomes nullable, for as-needed occurrences. The unique key on (chore, due date) stays; SQLite allows several nulls, and an as-needed chore has at most one open occurrence anyway.
- `assignment_source` on occurrences keeps its values; `'default'` remains for history rows made before the change, and new occurrences use `'claimed'` or `'admin'`.

Existing rows:

- Open occurrences with no assignee are deleted (no to-dos exist for them).
- Open occurrences with an assignee are kept, and their chore's assignee is set to that person. If a chore has none, its old default assignee carries over as its assignee and gets an occurrence on the next generation run.
- Done and skipped occurrences (history) are untouched.

Live data on 2026-11-18: three chores, all unassigned, none open, so they simply appear on the board.

## API

Under the Chores panel's routes, following the existing conventions (main spec §13):

- `GET /board`: the board rows in order (chore, frequency summary, assignee, state, next or due date, open occurrence id).
- `POST /chores/:id/claim`, `POST /chores/:id/release`, `POST /chores/:id/assign` (admins; a user id or null).
- `POST /chores` (anyone; members may only set themselves or nobody as assignee). Edit, pause, resume and archive stay admin-only.
- Completing goes through the open occurrence as today.
- The occurrence-level claim, hand back and assign endpoints go away, along with their UI.

## Testing

- Unit: next due date for every schedule kind (on assignment, after an early close, after a late close, start date in the future, month ends), and the board's sort order.
- Service: claim, take over (due date and overdue state kept, to-do moved), release, admin assign and unassign, complete early then the job after the due date, complete late, skip, as needed returning to the board, pause and resume keeping the assignee, archive clearing it, a deactivated assignee, and the migration of existing rows.
- e2e: the board (order, claim, take over, release), a claimed chore appearing on the to-do list with the right due date, the home tile's three sections and its 6-row limit, and adding a chore as a member.
- Existing Todoist, retry and stuck tests keep passing.

## Deploying

The migration needs the usual backup inside the container first (`pre-chore-board-<date>.db`) and a rehearsal on a local copy of it.
