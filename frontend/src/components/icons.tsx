interface IconProps {
  size?: number;
  className?: string;
}

const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: "0 0 20 20",
  fill: "none" as const,
  "aria-hidden": true as const,
});

export function GridIcon({ size = 18, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <rect x="2.5" y="2.5" width="6" height="6" rx="1.2" stroke="currentColor" strokeWidth="1.5" />
      <rect x="11.5" y="2.5" width="6" height="6" rx="1.2" stroke="currentColor" strokeWidth="1.5" />
      <rect x="2.5" y="11.5" width="6" height="6" rx="1.2" stroke="currentColor" strokeWidth="1.5" />
      <rect x="11.5" y="11.5" width="6" height="6" rx="1.2" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

export function MoreIcon({ size = 18, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <circle cx="4.5" cy="10" r="1.4" fill="currentColor" />
      <circle cx="10" cy="10" r="1.4" fill="currentColor" />
      <circle cx="15.5" cy="10" r="1.4" fill="currentColor" />
    </svg>
  );
}

export function GearIcon({ size = 18, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <circle cx="10" cy="10" r="2.6" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M10 2.5v2M10 15.5v2M17.5 10h-2M4.5 10h-2M15.3 4.7l-1.4 1.4M6.1 13.9l-1.4 1.4M15.3 15.3l-1.4-1.4M6.1 6.1 4.7 4.7"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function UsersIcon({ size = 18, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <circle cx="7.2" cy="6.5" r="2.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M2.5 17c0-2.8 2.1-4.5 4.7-4.5s4.7 1.7 4.7 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path
        d="M12.8 4.3c1.3.3 2.3 1.4 2.3 2.9 0 1.3-.7 2.2-1.7 2.7M14.5 12.7c2 .4 3 1.9 3 4.3"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function DatabaseIcon({ size = 18, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <ellipse cx="10" cy="5" rx="6" ry="2.3" stroke="currentColor" strokeWidth="1.5" />
      <path d="M4 5v10c0 1.27 2.69 2.3 6 2.3s6-1.03 6-2.3V5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M4 10c0 1.27 2.69 2.3 6 2.3s6-1.03 6-2.3" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

export function LogoutIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path
        d="M7.5 17H4.8A1.3 1.3 0 0 1 3.5 15.7V4.3A1.3 1.3 0 0 1 4.8 3H7.5M13 13.5 17 10l-4-3.5M17 10H7.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ChevronDownIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M4.5 7.5 10 13l5.5-5.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function FolderIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path
        d="M2.5 5.3c0-.7.6-1.3 1.3-1.3h3.4l1.4 1.7h7.6c.7 0 1.3.6 1.3 1.3v7.7c0 .7-.6 1.3-1.3 1.3H3.8c-.7 0-1.3-.6-1.3-1.3V5.3Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** A folder with an arrow leaving it — "move this folder somewhere else". */
export function FolderMoveIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path
        d="M17.5 9V7c0-.7-.6-1.3-1.3-1.3H8.6L7.2 4H3.8c-.7 0-1.3.6-1.3 1.3v9.4c0 .7.6 1.3 1.3 1.3h5.7"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M12.5 13.5h5m0 0-2-2m2 2-2 2"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function CheckIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="m4.5 10.5 3.5 3.5 7.5-8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function CheckCircleIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <circle cx="10" cy="10" r="7.2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M6.8 10.2 9 12.4l4.2-4.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function DocumentIcon({ size = 18, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path
        d="M5.5 2.5h6l3 3v11.2a.8.8 0 0 1-.8.8H5.5a.8.8 0 0 1-.8-.8V3.3a.8.8 0 0 1 .8-.8Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M11.5 2.5v3h3" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M7 11h6M7 14h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function FilePdfIcon({ size = 18, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path
        d="M5.5 2.5h6l3 3v11.2a.8.8 0 0 1-.8.8H5.5a.8.8 0 0 1-.8-.8V3.3a.8.8 0 0 1 .8-.8Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M11.5 2.5v3h3" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <rect x="6.4" y="10.8" width="7.2" height="4.2" rx="0.9" fill="currentColor" />
    </svg>
  );
}

export function FileImageIcon({ size = 18, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <rect x="3" y="4.5" width="14" height="11" rx="1.6" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="7.2" cy="8.4" r="1.3" stroke="currentColor" strokeWidth="1.3" />
      <path d="M3.8 14.5 8 10.7l2.4 2.3 2.6-3 3.2 3.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function FileSheetIcon({ size = 18, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <rect x="3.5" y="3.5" width="13" height="13" rx="1.6" stroke="currentColor" strokeWidth="1.5" />
      <path d="M3.5 8h13M3.5 12h13M8 3.5v13M12 3.5v13" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

export function BellIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path
        d="M10 2.7c-2.1 0-3.7 1.7-3.7 3.8v2.6c0 .5-.2 1-.5 1.4l-1 1.2c-.5.6-.1 1.5.6 1.5h9.2c.7 0 1.1-.9.6-1.5l-1-1.2c-.3-.4-.5-.9-.5-1.4V6.5c0-2.1-1.6-3.8-3.7-3.8Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M8.3 15.3a1.8 1.8 0 0 0 3.4 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function BoltIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path
        d="M10.8 2.3 4.2 11.5h4.3l-1.3 6.2 7.1-9.7h-4.5l1-5.7Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function ChevronLeftIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M12.5 4.5 7 10l5.5 5.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ChevronRightIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M7.5 4.5 13 10l-5.5 5.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function LockIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <rect x="4.5" y="8.5" width="11" height="8" rx="1.6" stroke="currentColor" strokeWidth="1.5" />
      <path d="M7 8.5V6.4a3 3 0 0 1 6 0v2.1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function SearchIcon({ size = 18, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <circle cx="9" cy="9" r="5.2" stroke="currentColor" strokeWidth="1.6" />
      <path d="m13 13 3.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function MailIcon({ size = 18, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <rect x="2.5" y="4.5" width="15" height="11" rx="1.8" stroke="currentColor" strokeWidth="1.5" />
      <path d="m3.5 6 6.5 4.8L16.5 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function PlusIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M10 4.5v11M4.5 10h11" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function TrashIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path
        d="M4 5.8h12M8.2 5.8V4.2c0-.5.4-.9.9-.9h1.8c.5 0 .9.4.9.9v1.6M5.6 5.8l.6 9.6c0 .7.6 1.3 1.3 1.3h5c.7 0 1.3-.6 1.3-1.3l.6-9.6"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function DragIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <circle cx="7.5" cy="5" r="1.1" fill="currentColor" />
      <circle cx="12.5" cy="5" r="1.1" fill="currentColor" />
      <circle cx="7.5" cy="10" r="1.1" fill="currentColor" />
      <circle cx="12.5" cy="10" r="1.1" fill="currentColor" />
      <circle cx="7.5" cy="15" r="1.1" fill="currentColor" />
      <circle cx="12.5" cy="15" r="1.1" fill="currentColor" />
    </svg>
  );
}

export function ShieldIcon({ size = 18, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path
        d="M10 2.8 4.5 5v4.6c0 3.4 2.3 6.5 5.5 7.6 3.2-1.1 5.5-4.2 5.5-7.6V5L10 2.8Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M7.6 10.1 9.3 11.8l3.1-3.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function TagIcon({ size = 18, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path
        d="M3.5 9.2V4.4c0-.5.4-.9.9-.9h4.8c.2 0 .5.1.6.3l6.4 6.4c.4.4.4.9 0 1.3l-4.8 4.8c-.4.4-.9.4-1.3 0L3.8 9.8a.9.9 0 0 1-.3-.6Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <circle cx="6.9" cy="6.9" r="1.1" fill="currentColor" />
    </svg>
  );
}

export function DownloadIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M10 3v9M6.5 8.5 10 12l3.5-3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4.5 14.5v1a1.5 1.5 0 0 0 1.5 1.5h8a1.5 1.5 0 0 0 1.5-1.5v-1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ClockIcon({ size = 15, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <circle cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10 6v4.2l2.8 1.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function UploadCloudIcon({ size = 20, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path
        d="M6 15.5a3.5 3.5 0 0 1-.4-7 4.5 4.5 0 0 1 8.7-1.4 3.4 3.4 0 0 1 1 6.6"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M10 17V9.5M7.3 11.7 10 9l2.7 2.7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function SlidersIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M4 6.5h8M15 6.5h1M4 13.5h1M8 13.5h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="13.5" cy="6.5" r="1.8" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="6.5" cy="13.5" r="1.8" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

export function PencilIcon({ size = 15, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path
        d="M13.4 3.6a1.5 1.5 0 0 1 2.1 2.1L6.8 14.4l-3 .8.8-3 8.8-8.6Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M12 5l2.1 2.1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function XIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M5 5l10 10M15 5 5 15" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function CopyIcon({ size = 15, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <rect x="7" y="7" width="9" height="9" rx="1.6" stroke="currentColor" strokeWidth="1.5" />
      <path d="M4 13V5.5A1.5 1.5 0 0 1 5.5 4H13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function RefreshIcon({ size = 15, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M15.5 6.5A6 6 0 1 0 16 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M15.8 3.5V7h-3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function CloudIcon({ size = 22, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path
        d="M6.2 15.3a3.7 3.7 0 0 1-.4-7.4 4.6 4.6 0 0 1 8.9-1.5 3.5 3.5 0 0 1 1.1 6.8"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M6.2 15.3h9.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Legal Hold — a pause mark in a shield-like disc: the document is held, not locked by role. */
export function HoldIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <circle cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8.2 7.2v5.6M11.8 7.2v5.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function ArrowRightIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M4 10h11.5M11 5.5 15.5 10 11 14.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function CalendarIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <rect x="3.5" y="4.5" width="13" height="12" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M3.5 8.5h13M7 3v3M13 3v3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function EyeIcon({ size = 18, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path
        d="M2.2 10S5 4.6 10 4.6 17.8 10 17.8 10 15 15.4 10 15.4 2.2 10 2.2 10Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <circle cx="10" cy="10" r="2.4" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

export function EyeOffIcon({ size = 18, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path
        d="M8.2 4.9A7 7 0 0 1 10 4.6c5 0 7.8 5.4 7.8 5.4a13 13 0 0 1-2.1 2.8M12.9 14.7a6.6 6.6 0 0 1-2.9.7C5 15.4 2.2 10 2.2 10a13.2 13.2 0 0 1 3.3-3.8"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M8.3 8.4a2.4 2.4 0 0 0 3.3 3.3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="m3.5 3.5 13 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
