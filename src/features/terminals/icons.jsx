// (C)
// Monochrome stroke SVG icons for the chrome (toolbar / ribbon / file bars).
// Reskinned for the mockup-23 look: every glyph is currentColor at ~1.4px
// stroke so it inherits the chrome's dim/active color and brightens on hover —
// no hard-coded hues. Names, signatures, and viewBoxes are unchanged from the
// old colorful set so every consumer keeps working as-is.
const S = ({ children, size = 17 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.4"
    strokeLinecap="round"
    strokeLinejoin="round"
    style={{ display: "block" }}
    aria-hidden="true"
  >
    {children}
  </svg>
);

export const IconSession = ({ size }) => (
  <S size={size}>
    <rect x="2" y="2.5" width="12" height="8.5" rx="1.2" />
    <path d="M6 14h4M8 11v3" />
  </S>
);

export const IconServers = ({ size }) => (
  <S size={size}>
    <rect x="2" y="2.1" width="12" height="3.4" rx="1" />
    <rect x="2" y="6.3" width="12" height="3.4" rx="1" />
    <rect x="2" y="10.5" width="12" height="3.4" rx="1" />
    <path d="M4.2 3.8h.01M4.2 8h.01M4.2 12.2h.01" />
  </S>
);

export const IconTools = ({ size }) => (
  <S size={size}>
    <circle cx="10.5" cy="5.5" r="3.2" />
    <path d="M8.2 7.8 2.5 13.5" />
  </S>
);

export const IconAsk = ({ size }) => (
  <S size={size}>
    <path d="M6.6 2l1 3.1 3.1 1-3.1 1-1 3.1-1-3.1-3.1-1 3.1-1z" />
    <path d="M12 9.4l.6 1.7 1.7.6-1.7.6-.6 1.7-.6-1.7-1.7-.6 1.7-.6z" />
  </S>
);

export const IconGames = ({ size }) => (
  <S size={size}>
    <rect x="1.6" y="5" width="12.8" height="6.2" rx="3.1" />
    <path d="M5.2 7.2v2M4.2 8.2h2" />
    <path d="M10.6 7.4h.01M11.6 9h.01" />
  </S>
);

export const IconStar = ({ size }) => (
  <S size={size}>
    <path d="M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6z" />
  </S>
);

export const IconView = ({ size }) => (
  <S size={size}>
    <rect x="1.8" y="2.5" width="12.4" height="11" rx="1.2" />
    <path d="M1.8 5.3h12.4" />
  </S>
);

export const IconSplit = ({ size }) => (
  <S size={size}>
    <rect x="1.8" y="2.5" width="12.4" height="11" rx="1.2" />
    <rect x="8" y="2.5" width="6.2" height="11" fill="currentColor" opacity="0.22" stroke="none" />
    <path d="M8 2.5v11" />
  </S>
);

export const IconMultiExec = ({ size }) => (
  <S size={size}>
    <path d="M8 13.5V8M8 8 3.6 3.6M8 8l4.4-4.4" />
    <circle cx="8" cy="13.5" r="1.4" />
    <circle cx="3.2" cy="3.2" r="1.4" />
    <circle cx="12.8" cy="3.2" r="1.4" />
  </S>
);

export const IconTunneling = ({ size }) => (
  <S size={size}>
    <path d="M2 5.5h9.5M11.5 5.5 9.3 3.3M11.5 5.5 9.3 7.7" />
    <path d="M14 10.5H4.5M4.5 10.5l2.2-2.2M4.5 10.5l2.2 2.2" />
  </S>
);

export const IconPackages = ({ size }) => (
  <S size={size}>
    <path d="M8 1.6l6 2.9v6.9l-6 2.9-6-2.9V4.5z" />
    <path d="M2 4.5l6 2.9 6-2.9M8 7.4v6.9" />
  </S>
);

export const IconSettings = ({ size }) => (
  <S size={size}>
    <circle cx="8" cy="8" r="2.2" />
    <path d="M8 1.5v2.1M8 12.4v2.1M1.5 8h2.1M12.4 8h2.1M3.4 3.4l1.5 1.5M11.1 11.1l1.5 1.5M12.6 3.4l-1.5 1.5M4.9 11.1l-1.5 1.5" />
  </S>
);

export const IconHelp = ({ size }) => (
  <S size={size}>
    <circle cx="8" cy="8" r="6.2" />
    <path d="M6.2 6.2A1.9 1.9 0 0 1 8 4.9c1 0 1.9.7 1.9 1.7 0 1.2-1.9 1.4-1.9 2.7" />
    <path d="M8 11.6h.01" />
  </S>
);

export const IconMoon = ({ size }) => (
  <S size={size}>
    <path d="M13.4 9.6A6 6 0 1 1 6.4 2.6a4.8 4.8 0 0 0 7 7z" />
  </S>
);

export const IconSun = ({ size }) => (
  <S size={size}>
    <circle cx="8" cy="8" r="3.1" />
    <path d="M8 1.4v1.8M8 12.8v1.8M1.4 8h1.8M12.8 8h1.8M3.3 3.3l1.3 1.3M11.4 11.4l1.3 1.3M12.7 3.3l-1.3 1.3M4.6 11.4l-1.3 1.3" />
  </S>
);

export const IconExit = ({ size }) => (
  <S size={size}>
    <path d="M11.5 4.2a5.4 5.4 0 1 1-7 0" />
    <path d="M8 1.8v5.4" />
  </S>
);

export const IconFolder = ({ size }) => (
  <S size={size}>
    <path d="M1.8 4.2a1 1 0 0 1 1-1h3.4l1.4 1.7h5.6a1 1 0 0 1 1 1v6.4a1 1 0 0 1-1 1H2.8a1 1 0 0 1-1-1z" />
  </S>
);

export const IconAgents = ({ size }) => (
  <S size={size}>
    <rect x="1.8" y="1.8" width="5.4" height="5.4" rx="1.1" />
    <rect x="8.8" y="1.8" width="5.4" height="5.4" rx="1.1" />
    <rect x="1.8" y="8.8" width="5.4" height="5.4" rx="1.1" />
    <rect x="8.8" y="8.8" width="5.4" height="5.4" rx="1.1" />
  </S>
);

/* ── File-explorer toolbar icons (SFTP / local files panel) ──────────────── */
export const IconHome = ({ size }) => (
  <S size={size}>
    <path d="M2.2 7.2 8 2.2l5.8 5M3.5 6.6v6.6h9V6.6" />
    <path d="M6.7 13.2V9.4h2.6v3.8" />
  </S>
);

export const IconUp = ({ size }) => (
  <S size={size}>
    <path d="M8 13.3V3M8 3 3.5 7.5M8 3l4.5 4.5" />
  </S>
);

export const IconRefresh = ({ size }) => (
  <S size={size}>
    <path d="M3.2 8a4.8 4.8 0 0 1 8.3-3.3M12.8 8a4.8 4.8 0 0 1-8.3 3.3" />
    <path d="M11.6 1.9v2.9H8.7M4.4 14.1v-2.9h2.9" />
  </S>
);

export const IconUpload = ({ size }) => (
  <S size={size}>
    <path d="M8 10.4V2.2M8 2.2 4.6 5.6M8 2.2l3.4 3.4" />
    <path d="M2.6 12.8h10.8" />
  </S>
);

export const IconDownload = ({ size }) => (
  <S size={size}>
    <path d="M8 2.2v8.2M8 10.4 4.6 7M8 10.4 11.4 7" />
    <path d="M2.6 12.8h10.8" />
  </S>
);

export const IconNewFolder = ({ size }) => (
  <S size={size}>
    <path d="M1.8 4.2a1 1 0 0 1 1-1h3.4l1.4 1.7h5.6a1 1 0 0 1 1 1v6.4a1 1 0 0 1-1 1H2.8a1 1 0 0 1-1-1z" />
    <path d="M11.6 8.2v3M10.1 9.7h3" />
  </S>
);

export const IconReveal = ({ size }) => (
  <S size={size}>
    <rect x="2" y="2.6" width="8.4" height="8.4" rx="1.2" />
    <path d="M8.6 2.6h4.8v4.8M13 3 7.6 8.4" />
  </S>
);

export const IconCd = ({ size }) => (
  <S size={size}>
    <rect x="1.6" y="2.6" width="12.8" height="10.8" rx="1.4" />
    <path d="M4.2 6l2.4 2-2.4 2M7.8 10.2h3.6" />
  </S>
);

// AI model chip — processor die with pins, signalling the LLM picker.
export const IconModels = ({ size }) => (
  <S size={size}>
    <rect x="3.8" y="3.8" width="8.4" height="8.4" rx="1.2" />
    <circle cx="8" cy="8" r="1.6" />
    <path d="M5.8 1.6v2.2M8 1.6v2.2M10.2 1.6v2.2M5.8 12.2v2.2M8 12.2v2.2M10.2 12.2v2.2M1.6 5.8h2.2M1.6 8h2.2M1.6 10.2h2.2M12.2 5.8h2.2M12.2 8h2.2M12.2 10.2h2.2" />
  </S>
);
