import type { ReactNode } from 'react';
import type { PanelId } from '../../shared/panels.js';

/**
 * The design system's line icons (docs/design-system/components/Card/preview.html): a 24px grid,
 * 2px stroke, round caps, currentColor. Decorative only: whatever sits beside them names the thing.
 */
const PATHS: Record<PanelId | 'chevron', ReactNode> = {
  calendar: (
    <>
      <rect x="3.5" y="5" width="17" height="15.5" rx="3.5" />
      <path d="M8 3v4M16 3v4M3.5 10h17" />
    </>
  ),
  todo: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m8.5 12.3 2.4 2.4 4.6-5" />
    </>
  ),
  chores: (
    <>
      <path d="M4 11 12 4l8 7" />
      <path d="M6 10v9.5h12V10" />
      <path d="M10 19.5V14h4v5.5" />
    </>
  ),
  spend: (
    <>
      <rect x="3" y="6" width="18" height="13" rx="3.5" />
      <path d="M3 10h18" />
      <circle cx="16.5" cy="14.5" r=".6" />
    </>
  ),
  savings: (
    <>
      <ellipse cx="12" cy="6.5" rx="7" ry="3" />
      <path d="M5 6.5v5c0 1.66 3.13 3 7 3s7-1.34 7-3v-5" />
      <path d="M5 11.5v5c0 1.66 3.13 3 7 3s7-1.34 7-3v-5" />
    </>
  ),
  chevron: <path d="m9 6 6 6-6 6" />,
};

export function Icon({ name, className }: { name: PanelId | 'chevron'; className?: string }) {
  return (
    <svg
      className={className ? `icon ${className}` : 'icon'}
      viewBox="0 0 24 24"
      width="24"
      height="24"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}

/** A panel's icon in its 44px circular badge, tinted by the nearest `panel-*` class. */
export function PanelBadge({ id }: { id: PanelId }) {
  return (
    <span className="card-badge" aria-hidden="true">
      <Icon name={id} />
    </span>
  );
}
