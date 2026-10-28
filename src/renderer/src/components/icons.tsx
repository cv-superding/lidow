/** 统一线性图标集（16px viewBox，currentColor 描边）——替换 emoji，避免各平台字形差异 */
type P = { size?: number; className?: string }

const base = (size = 16): React.SVGProps<SVGSVGElement> => ({
  width: size,
  height: size,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.4,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const
})

export function IconHome({ size, className }: P): React.JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <path d="M2.5 6.5 8 2l5.5 4.5V13a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V6.5Z" />
      <path d="M6.5 14v-4h3v4" />
    </svg>
  )
}

export function IconChat({ size, className }: P): React.JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2v-7Z" />
    </svg>
  )
}

export function IconFolder({ size, className }: P): React.JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <path d="M2 4.5A1 1 0 0 1 3 3.5h3l1.5 2h5.5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-8Z" />
    </svg>
  )
}

export function IconCheck({ size, className }: P): React.JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
      <path d="M5.5 8.2 7.2 10l3.3-3.6" />
    </svg>
  )
}

export function IconPlugin({ size, className }: P): React.JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <path d="M6 2.5h4v2a1.5 1.5 0 1 0 3 0h.5v4h-2a1.5 1.5 0 1 0 0 3h2v2.5h-4v-2a1.5 1.5 0 1 0-3 0v2H2.5V11h2a1.5 1.5 0 1 0 0-3h-2V4.5H3a1.5 1.5 0 1 0 3 0v-2Z" />
    </svg>
  )
}

export function IconBrain({ size, className }: P): React.JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <path d="M8 3.2a2.2 2.2 0 0 0-4 1.2 2 2 0 0 0-1.2 3.2A2.2 2.2 0 0 0 4 11.5a2.2 2.2 0 0 0 4 .8V3.2Z" />
      <path d="M8 3.2a2.2 2.2 0 0 1 4 1.2 2 2 0 0 1 1.2 3.2A2.2 2.2 0 0 1 12 11.5a2.2 2.2 0 0 1-4 .8" />
    </svg>
  )
}

export function IconBook({ size, className }: P): React.JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <path d="M2.5 3.2A1.2 1.2 0 0 1 3.7 2H7v11H3.7a1.2 1.2 0 0 1-1.2-1.2V3.2Z" />
      <path d="M13.5 3.2A1.2 1.2 0 0 0 12.3 2H9v11h3.3a1.2 1.2 0 0 0 1.2-1.2V3.2Z" />
    </svg>
  )
}

export function IconHistory({ size, className }: P): React.JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 4.8V8l2.2 1.6" />
    </svg>
  )
}

export function IconSettings({ size, className }: P): React.JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <circle cx="8" cy="8" r="2" />
      <path d="M8 1.8v1.6M8 12.6v1.6M2.4 8h1.6M12 8h1.6M4 4l1.1 1.1M10.9 10.9 12 12M12 4l-1.1 1.1M5.1 10.9 4 12" />
    </svg>
  )
}

export function IconPure({ size, className }: P): React.JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />
      <path d="M2.5 6h11M6 6v7.5" />
    </svg>
  )
}

export function IconPlus({ size, className }: P): React.JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <path d="M8 3.5v9M3.5 8h9" />
    </svg>
  )
}

export function IconClose({ size, className }: P): React.JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  )
}

export function IconChevronLeft({ size, className }: P): React.JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <path d="M9.5 3.5 5 8l4.5 4.5" />
    </svg>
  )
}

export function IconChevronRight({ size, className }: P): React.JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <path d="M6.5 3.5 11 8l-4.5 4.5" />
    </svg>
  )
}

export function IconArrowUp({ size, className }: P): React.JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <path d="M8 13V3.5M4 7l4-3.5L12 7" />
    </svg>
  )
}

export function IconStop({ size, className }: P): React.JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <rect x="4.5" y="4.5" width="7" height="7" rx="1.2" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function IconDownload({ size, className }: P): React.JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <path d="M8 2.5v7M5 6.8 8 9.8l3-3M3 12.5h10" />
    </svg>
  )
}

export function IconCompress({ size, className }: P): React.JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <path d="M5.5 2.5v3h-3M10.5 13.5v-3h3M2.5 5.5l3-3M13.5 10.5l-3 3" />
    </svg>
  )
}

export function IconSearch({ size, className }: P): React.JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <circle cx="7" cy="7" r="4.2" />
      <path d="M10.2 10.2 13.5 13.5" />
    </svg>
  )
}

export function IconMinimize({ size = 12, className }: P): React.JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <path d="M3 8h10" />
    </svg>
  )
}

export function IconMaximize({ size = 12, className }: P): React.JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <rect x="3.5" y="3.5" width="9" height="9" rx="1" />
    </svg>
  )
}

export function IconRestore({ size = 12, className }: P): React.JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <rect x="3" y="5.5" width="7.5" height="7.5" rx="1" />
      <path d="M5.5 5.5V3.5a1 1 0 0 1 1-1H12a1 1 0 0 1 1 1v5.5a1 1 0 0 1-1 1h-2" />
    </svg>
  )
}

export function IconFile({ size, className }: P): React.JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <path d="M4 2.5h5L12 5.5v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1Z" />
      <path d="M9 2.5v3h3" />
    </svg>
  )
}

export function IconFolderOpen({ size, className }: P): React.JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <path d="M2 12V4.5a1 1 0 0 1 1-1h3l1.5 2h4a1 1 0 0 1 1 1V7" />
      <path d="M2.2 12.5 4 7h10.5l-1.8 5.5H2.2Z" />
    </svg>
  )
}

export const RAIL_ICONS = {
  home: IconHome,
  sessions: IconChat,
  files: IconFolder,
  tasks: IconCheck,
  plugins: IconPlugin,
  memory: IconBrain,
  knowledge: IconBook,
  audit: IconHistory,
  settings: IconSettings
} as const
