import { avatarInk } from '../avatarInk.js';

/**
 * A person's initial on their own (free-form) color, with whichever on-fill ink reads better on it.
 * Decorative: whatever sits beside it names the person, so it's hidden from assistive tech.
 */
export function Avatar({ person, size, className }: { person: { displayName: string; color: string }; size?: 'md'; className?: string }) {
  return (
    <span
      className={['avatar', size === 'md' ? 'avatar-md' : '', className ?? ''].filter(Boolean).join(' ')}
      style={{ backgroundColor: person.color, color: avatarInk(person.color) }}
      aria-hidden="true"
    >
      {person.displayName.slice(0, 1).toUpperCase()}
    </span>
  );
}

/**
 * A few overlapping avatars, e.g. everyone else with open chores: at most `max` of them, so a big
 * family can't push the row wider than the card. The text beside it names everyone.
 */
export function AvatarStack({ people, max = 4 }: { people: { id: number; displayName: string; color: string }[]; max?: number }) {
  if (people.length === 0) return null;
  return (
    <span className="avatar-stack" aria-hidden="true">
      {people.slice(0, max).map((p) => <Avatar key={p.id} person={p} />)}
    </span>
  );
}
