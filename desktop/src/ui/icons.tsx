/**
 * The icon family for this product. One style, one file.
 *
 * Rules (docs/design-system.md, "Icons"):
 * • 24×24 viewBox, geometry drawn on the pixel grid, `strokeWidth: 1.75`,
 *   round caps and joins, `fill: none`, `stroke: currentColor`.
 * • Nothing is filled at the same hierarchy level as something outlined —
 *   mixing the two is how an icon row stops reading as one set.
 * • Every icon is `aria-hidden` unless it carries meaning alone, in which case
 *   it gets `label` (rendered as `role="img"` + `aria-label`) and the caller
 *   keeps the visible text out of the button.
 * • Bundled as inline SVG: the app runs with the network off, so there is no
 *   icon font, no sprite fetch and no CDN.
 */
import type { ReactNode, SVGProps } from 'react';

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'children'> {
  /** Rendered box in CSS pixels; the grid stays 24 regardless. */
  size?: number;
  /** Accessible name. Only for an icon that stands alone. */
  label?: string;
  /** Optical weight — 1.75 is the system default, 2 for a 28px+ display. */
  strokeWidth?: number;
}

function Icon({ size = 20, label, strokeWidth = 1.75, className, children, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`icon${className ? ` ${className}` : ''}`}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? 'img' : undefined}
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

/* --------------------------------------------------------------- sections */
/** خانه — a roof over an open door: the way back. */
export const IconHome = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 11 12 4l8 7" />
    <path d="M6.5 9.5V19a1 1 0 0 0 1 1H11v-5h2v5h3.5a1 1 0 0 0 1-1V9.5" />
  </Icon>
);

/** قرآن — an open book, the mushaf seen from above. */
export const IconBookOpen = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 6.5C10.4 5.2 8.2 4.5 5.5 4.5A1.5 1.5 0 0 0 4 6v11.5c0 .8.7 1.5 1.5 1.5 2.7 0 4.9.7 6.5 2 1.6-1.3 3.8-2 6.5-2 .8 0 1.5-.7 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5C15.8 4.5 13.6 5.2 12 6.5Z" />
    <path d="M12 6.5V19" />
  </Icon>
);

/** حفظ — a crescent: the memorisation area keeps its own mark. */
export const IconMoon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />
    <path d="M16.5 4.5v3M15 6h3" />
  </Icon>
);

/** کاوش — a compass needle: search, concepts, mutashabihat. */
export const IconCompass = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="m15 9-1.6 4.4L9 15l1.6-4.4L15 9Z" />
  </Icon>
);

/** من — a person: settings, notes, about. */
export const IconUser = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="8" r="3.5" />
    <path d="M5 20c.6-3.6 3.4-5.5 7-5.5s6.4 1.9 7 5.5" />
  </Icon>
);

/** بیشتر — the overflow affordance in the phone tab bar. */
export const IconMore = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="5.5" cy="12" r="1.15" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.15" fill="currentColor" stroke="none" />
    <circle cx="18.5" cy="12" r="1.15" fill="currentColor" stroke="none" />
  </Icon>
);

/* ---------------------------------------------------------------- actions */
export const IconSearch = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m16 16 4 4" />
  </Icon>
);
export const IconClose = (p: IconProps) => (
  <Icon {...p}>
    <path d="m6 6 12 12M18 6 6 18" />
  </Icon>
);
export const IconCheck = (p: IconProps) => (
  <Icon {...p}>
    <path d="m4.5 12.5 5 5 10-11" />
  </Icon>
);
export const IconChevronStart = (p: IconProps) => (
  <Icon {...p}>
    <path d="m14.5 5.5-7 6.5 7 6.5" />
  </Icon>
);
export const IconChevronEnd = (p: IconProps) => (
  <Icon {...p}>
    <path d="m9.5 5.5 7 6.5-7 6.5" />
  </Icon>
);
export const IconArrowStart = (p: IconProps) => (
  <Icon {...p}>
    <path d="M20 12H4.5M11 5.5 4.5 12l6.5 6.5" />
  </Icon>
);
export const IconRefresh = (p: IconProps) => (
  <Icon {...p}>
    <path d="M20 11.5A8 8 0 1 0 18 17" />
    <path d="M20 5.5v6h-6" />
  </Icon>
);
export const IconDownload = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 4v11M7.5 10.5 12 15l4.5-4.5" />
    <path d="M4.5 19.5h15" />
  </Icon>
);
export const IconUpload = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 15V4M7.5 8.5 12 4l4.5 4.5" />
    <path d="M4.5 19.5h15" />
  </Icon>
);
export const IconBookmark = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6.5 4.5h11v15l-5.5-4-5.5 4v-15Z" />
  </Icon>
);
export const IconTrash = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4.5 7h15M9.5 7V4.8h5V7M6.5 7l.9 12.2a1.3 1.3 0 0 0 1.3 1.3h6.6a1.3 1.3 0 0 0 1.3-1.3L17.5 7" />
  </Icon>
);
export const IconPlus = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);
export const IconMinus = (p: IconProps) => (
  <Icon {...p}>
    <path d="M5 12h14" />
  </Icon>
);
export const IconPlay = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8 5.5 18 12 8 18.5v-13Z" />
  </Icon>
);
export const IconMic = (p: IconProps) => (
  <Icon {...p}>
    <rect x="9" y="3.5" width="6" height="11" rx="3" />
    <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v2.5" />
  </Icon>
);
export const IconClock = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3.5 2" />
  </Icon>
);
export const IconFilter = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 6h16M7 12h10M10 18h4" />
  </Icon>
);
export const IconList = (p: IconProps) => (
  <Icon {...p}>
    <path d="M9 6.5h11M9 12h11M9 17.5h11" />
    <circle cx="5" cy="6.5" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="5" cy="12" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="5" cy="17.5" r="1.1" fill="currentColor" stroke="none" />
  </Icon>
);
export const IconGrid = (p: IconProps) => (
  <Icon {...p}>
    <rect x="4" y="4" width="7" height="7" rx="1.5" />
    <rect x="13" y="4" width="7" height="7" rx="1.5" />
    <rect x="4" y="13" width="7" height="7" rx="1.5" />
    <rect x="13" y="13" width="7" height="7" rx="1.5" />
  </Icon>
);
export const IconExternal = (p: IconProps) => (
  <Icon {...p}>
    <path d="M14 4.5h5.5V10M19.5 4.5 12 12" />
    <path d="M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10" />
  </Icon>
);
export const IconSettings = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 3.5v2.2M12 18.3v2.2M4.9 7.8l1.9 1.1M17.2 15.1l1.9 1.1M4.9 16.2l1.9-1.1M17.2 8.9l1.9-1.1" />
  </Icon>
);
export const IconNote = (p: IconProps) => (
  <Icon {...p}>
    <path d="M5.5 4.5h13v10l-5 5h-8v-15Z" />
    <path d="M13.5 19.5v-5h5M8.5 8.5h7M8.5 12h5" />
  </Icon>
);
export const IconChart = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4.5 19.5h15" />
    <path d="M7.5 16v-5M12 16V6.5M16.5 16v-7" />
  </Icon>
);
export const IconLayers = (p: IconProps) => (
  <Icon {...p}>
    <path d="m12 4 8 4-8 4-8-4 8-4Z" />
    <path d="m4 13 8 4 8-4" />
  </Icon>
);
export const IconPages = (p: IconProps) => (
  <Icon {...p}>
    <rect x="4" y="6" width="11" height="14" rx="1.5" />
    <path d="M8 6V4.5A1.5 1.5 0 0 1 9.5 3H19a1.5 1.5 0 0 1 1.5 1.5V17a1.5 1.5 0 0 1-1.5 1.5h-1.5" />
  </Icon>
);
export const IconDatabase = (p: IconProps) => (
  <Icon {...p}>
    <ellipse cx="12" cy="6.5" rx="7.5" ry="3" />
    <path d="M4.5 6.5v11c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-11" />
    <path d="M4.5 12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3" />
  </Icon>
);
export const IconShield = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3.5 5 6v6c0 4.2 3 7.2 7 8.5 4-1.3 7-4.3 7-8.5V6l-7-2.5Z" />
    <path d="m9 12 2.2 2.2L15.5 10" />
  </Icon>
);
export const IconSparkle = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 4.5c.8 3.4 1.6 4.2 5 5-3.4.8-4.2 1.6-5 5-.8-3.4-1.6-4.2-5-5 3.4-.8 4.2-1.6 5-5Z" />
    <path d="M18.5 15.5c.3 1.3.6 1.6 1.9 1.9-1.3.3-1.6.6-1.9 1.9-.3-1.3-.6-1.6-1.9-1.9 1.3-.3 1.6-.6 1.9-1.9Z" />
  </Icon>
);
export const IconAlert = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 4.5 3.5 19h17L12 4.5Z" />
    <path d="M12 10v4M12 16.6v.4" />
  </Icon>
);
export const IconInfo = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 11v5.5M12 7.8v.4" />
  </Icon>
);
export const IconInbox = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 13.5 6.5 5h11L20 13.5V18a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18v-4.5Z" />
    <path d="M4 13.5h4.5l1.5 2.5h4l1.5-2.5H20" />
  </Icon>
);
export const IconOffline = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 18.5v.4" />
    <path d="M8.4 15.2a5 5 0 0 1 7.2 0" />
    <path d="M5 11.7a9.6 9.6 0 0 1 14 0" />
    <path d="m4 4 16 16" />
  </Icon>
);
export const IconSun = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6 18 18M18 6l-1.4 1.4M7.4 16.6 6 18" />
  </Icon>
);
export const IconContrast = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 3.5a8.5 8.5 0 0 1 0 17Z" fill="currentColor" stroke="none" />
  </Icon>
);
export const IconMonitor = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3.5" y="5" width="17" height="11.5" rx="1.5" />
    <path d="M9 20h6M12 16.5V20" />
  </Icon>
);
export const IconLanguage = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M3.7 9.5h16.6M3.7 14.5h16.6" />
    <path d="M12 3.5c2.4 2.4 3.6 5.3 3.6 8.5S14.4 18.1 12 20.5c-2.4-2.4-3.6-5.3-3.6-8.5S9.6 5.9 12 3.5Z" />
  </Icon>
);
export const IconTarget = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <circle cx="12" cy="12" r="4.5" />
    <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
  </Icon>
);
export const IconRoute = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="6" cy="6.5" r="2.5" />
    <circle cx="18" cy="17.5" r="2.5" />
    <path d="M8.5 6.5H14a3 3 0 0 1 0 6h-4a3 3 0 0 0 0 6h5.5" />
  </Icon>
);
