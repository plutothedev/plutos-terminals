// (C)
// Crisp stroke (line) icons for the workstation toolbar — ported 1:1 from the
// locked mockup (design-mockups/12). Monochrome, currentColor, so they take the
// toolbar's dim/active color. Feather/Lucide-grade, not the filled icon set.
const S = ({ children, size = 17 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    style={{ display: "block" }}
    aria-hidden="true"
  >
    {children}
  </svg>
);

export const SLocal = ({ size }) => (
  <S size={size}><rect x="2" y="2.5" width="12" height="8.5" rx="1.2" /><path d="M6 14h4M8 11v3" /></S>
);
export const SSsh = ({ size }) => (
  <S size={size}><circle cx="8" cy="8" r="6" /><path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12" /></S>
);
export const SSerial = ({ size }) => (
  <S size={size}><rect x="3" y="4" width="10" height="8" rx="1.2" /><path d="M6 4V2.5M10 4V2.5M6 13.5V12M10 13.5V12" /></S>
);
export const SSplit = ({ size }) => (
  <S size={size}><rect x="2" y="2.5" width="12" height="11" rx="1.4" /><path d="M8 2.5v11" /></S>
);
// Split-direction glyphs for the Split dropdown: a pane divided into two, with the
// active (new) half tinted so the direction reads at a glance.
export const SSplitRow = ({ size }) => (
  <S size={size}>
    <rect x="2" y="2.5" width="12" height="11" rx="1.4" />
    <rect x="8" y="2.5" width="6" height="11" fill="currentColor" opacity="0.25" stroke="none" />
    <path d="M8 2.5v11" />
  </S>
);
export const SSplitCol = ({ size }) => (
  <S size={size}>
    <rect x="2" y="2.5" width="12" height="11" rx="1.4" />
    <rect x="2" y="8" width="12" height="5.5" fill="currentColor" opacity="0.25" stroke="none" />
    <path d="M2 8h12" />
  </S>
);
export const SMultiX = ({ size }) => (
  <S size={size}><path d="M2 5a8 8 0 0 1 9 9M2 9a4 4 0 0 1 5 5" /><circle cx="3" cy="13" r="1" /></S>
);
export const STunnel = ({ size }) => (
  <S size={size}><path d="M2 5h7a3 3 0 0 1 0 6H4M2 11h7" /><path d="M4 3 2 5l2 2M12 9l2 2-2 2" /></S>
);
export const SAsk = ({ size }) => (
  <S size={size}><path d="M8 2l1.3 3.5L13 7l-3.7 1.5L8 12l-1.3-3.5L3 7l3.7-1.5z" /></S>
);
export const SModels = ({ size }) => (
  <S size={size}><rect x="4" y="4" width="8" height="8" rx="1.2" /><path d="M6.5 1.5v2M9.5 1.5v2M6.5 12.5v2M9.5 12.5v2M1.5 6.5h2M1.5 9.5h2M12.5 6.5h2M12.5 9.5h2" /></S>
);
export const SSnips = ({ size }) => (
  <S size={size}><rect x="3.5" y="3" width="9" height="11" rx="1.4" /><path d="M6 3V2h4v1M6 7h4M6 10h2.5" /></S>
);
export const SAgents = ({ size }) => (
  <S size={size}><circle cx="4.5" cy="3.5" r="1.7" /><circle cx="4.5" cy="12.5" r="1.7" /><circle cx="11.5" cy="3.5" r="1.7" /><path d="M4.5 5.2v5.6M4.5 8.5h3a4 4 0 0 0 4-4V5.2" /></S>
);
export const SSearch = ({ size }) => (
  <S size={size}><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5 14 14" /></S>
);
export const SPulse = ({ size }) => (
  <S size={size}><path d="M1.5 8h3l2-5 3 10 2-5h3" /></S>
);

/* ── Reskin (mockup 23): chrome glyphs that used to be emoji ─────────────────────
   Same grammar as the set above — 16×16, currentColor, 1.5px stroke. */
export const SMouse = ({ size }) => (
  <S size={size}><rect x="4.5" y="1.5" width="7" height="13" rx="3.5" /><path d="M8 4.5v3" /></S>
);
export const SWindows = ({ size }) => (
  <S size={size}><rect x="2" y="2.5" width="12" height="11" rx="1.2" /><path d="M2 8h12M8 2.5v11" /></S>
);
export const SFolder = ({ size }) => (
  <S size={size}><path d="M1.8 4.2a1 1 0 0 1 1-1h3.4l1.4 1.7h5.6a1 1 0 0 1 1 1v6.4a1 1 0 0 1-1 1H2.8a1 1 0 0 1-1-1z" /></S>
);
export const SLock = ({ size }) => (
  <S size={size}><rect x="3.5" y="7" width="9" height="7" rx="1.2" /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" /><path d="M8 10v1.5" /></S>
);
export const SKey = ({ size }) => (
  <S size={size}><circle cx="5" cy="11" r="3" /><path d="M7.2 8.8 13.5 2.5M11 5l2 2M9 7l1.5 1.5" /></S>
);
export const SMoon = ({ size }) => (
  <S size={size}><path d="M13.5 9.5a6 6 0 1 1-7-7 4.8 4.8 0 0 0 7 7z" /></S>
);
export const SSun = ({ size }) => (
  <S size={size}><circle cx="8" cy="8" r="3" /><path d="M8 1.5v1.8M8 12.7v1.8M1.5 8h1.8M12.7 8h1.8M3.4 3.4l1.3 1.3M11.3 11.3l1.3 1.3M12.6 3.4l-1.3 1.3M4.7 11.3l-1.3 1.3" /></S>
);
export const SRocket = ({ size }) => (
  <S size={size}><path d="M8 1.8c2.4 1.5 3.6 4 3.6 6.8L8 11.4 4.4 8.6C4.4 5.8 5.6 3.3 8 1.8z" /><circle cx="8" cy="6.4" r="1.2" /><path d="M4.4 10.6c-1 .6-1.6 2-1.6 3.4 1.4 0 2.8-.6 3.4-1.6M11.6 10.6c1 .6 1.6 2 1.6 3.4-1.4 0-2.8-.6-3.4-1.6" /></S>
);
export const SBook = ({ size }) => (
  <S size={size}><path d="M2.5 3.2C3.8 2.4 5.7 2.4 8 3.6c2.3-1.2 4.2-1.2 5.5-.4v9.2c-1.3-.8-3.2-.8-5.5.4-2.3-1.2-4.2-1.2-5.5-.4z" /><path d="M8 3.6v9.2" /></S>
);
export const SGear = ({ size }) => (
  <S size={size}><circle cx="8" cy="8" r="2.2" /><path d="M8 1.6v2M8 12.4v2M1.6 8h2M12.4 8h2M3.5 3.5l1.4 1.4M11.1 11.1l1.4 1.4M12.5 3.5l-1.4 1.4M4.9 11.1l-1.4 1.4" /></S>
);
export const SBot = ({ size }) => (
  <S size={size}><rect x="3" y="5" width="10" height="8" rx="1.6" /><path d="M8 5V2.8M6 13v1.2M10 13v1.2" /><circle cx="8" cy="2.3" r="0.7" /><path d="M5.8 8.4v1.2M10.2 8.4v1.2" /></S>
);
export const SDoc = ({ size }) => (
  <S size={size}><path d="M4 1.8h5.4L12.6 5v9.2H4z" /><path d="M9.2 1.8V5h3.4M6 8h4M6 10.6h4" /></S>
);
export const SClock = ({ size }) => (
  <S size={size}><circle cx="8" cy="8" r="6" /><path d="M8 4.6V8l2.4 1.6" /></S>
);
export const SLayout = ({ size }) => (
  <S size={size}><rect x="2" y="2.5" width="12" height="11" rx="1.2" /><path d="M2 6.2h12M7 6.2v7.3" /></S>
);
export const SBroadcast = ({ size }) => (
  <S size={size}><circle cx="8" cy="7" r="1.3" /><path d="M8 8.5v5.5M4.8 10.2a4.5 4.5 0 0 1 0-6.4M11.2 3.8a4.5 4.5 0 0 1 0 6.4M2.7 12.3a7.5 7.5 0 0 1 0-10.6M13.3 1.7a7.5 7.5 0 0 1 0 10.6" /></S>
);
export const STarget = ({ size }) => (
  <S size={size}><circle cx="8" cy="8" r="6" /><circle cx="8" cy="8" r="3" /><circle cx="8" cy="8" r="0.4" /></S>
);
export const SPlug = ({ size }) => (
  <S size={size}><path d="M5.5 1.5V5M10.5 1.5V5" /><path d="M4 5h8v2.5a4 4 0 0 1-8 0z" /><path d="M8 11.5v3" /></S>
);
export const SPhone = ({ size }) => (
  <S size={size}><rect x="4.5" y="1.5" width="7" height="13" rx="1.4" /><path d="M7 12.4h2" /></S>
);
export const SLink = ({ size }) => (
  <S size={size}><path d="M6.8 9.2 9.2 6.8" /><path d="M7.5 4.6 9 3.1a2.8 2.8 0 0 1 3.9 3.9l-1.5 1.5M8.5 11.4 7 12.9a2.8 2.8 0 0 1-3.9-3.9l1.5-1.5" /></S>
);
export const SRecord = ({ size }) => (
  <S size={size}><circle cx="8" cy="8" r="6" /><circle cx="8" cy="8" r="2.2" fill="currentColor" stroke="none" /></S>
);
export const SStop = ({ size }) => (
  <S size={size}><circle cx="8" cy="8" r="6" /><rect x="5.8" y="5.8" width="4.4" height="4.4" rx="0.6" fill="currentColor" stroke="none" /></S>
);
export const SReset = ({ size }) => (
  <S size={size}><path d="M13.2 8A5.2 5.2 0 1 1 8 2.8c1.9 0 3.5.9 4.4 2.3" /><path d="M12.8 1.8v3.4H9.4" /></S>
);
export const SServer = ({ size }) => (
  <S size={size}><rect x="2" y="2.5" width="12" height="4.6" rx="1" /><rect x="2" y="8.9" width="12" height="4.6" rx="1" /><path d="M4.4 4.8h.01M4.4 11.2h.01" /></S>
);
export const SBox = ({ size }) => (
  <S size={size}><path d="M8 1.8 14 4.7v6.6L8 14.2 2 11.3V4.7z" /><path d="M2 4.7l6 2.9 6-2.9M8 7.6v6.6" /></S>
);
export const STrash = ({ size }) => (
  <S size={size}><path d="M2.5 4h11M5.5 4V2.5h5V4M4 4l.8 9.5h6.4L12 4" /><path d="M6.7 6.8v4M9.3 6.8v4" /></S>
);
export const SPalette = ({ size }) => (
  <S size={size}><path d="M8 1.8a6.2 6.2 0 1 0 0 12.4c1 0 1.4-.6 1.4-1.3 0-.9-.8-1.3-.8-2.1 0-.8.7-1.3 1.6-1.3h1.6c1.4 0 2.4-1 2.4-2.4C14.2 4 11.4 1.8 8 1.8z" /><path d="M4.8 6.2h.01M7.6 4.4h.01M10.8 5.4h.01" /></S>
);
export const SKeyboard = ({ size }) => (
  <S size={size}><rect x="1.6" y="4" width="12.8" height="8" rx="1.2" /><path d="M4 6.6h.01M6.7 6.6h.01M9.4 6.6h.01M12 6.6h.01M5 9.4h6" /></S>
);
export const SSend = ({ size }) => (
  <S size={size}><path d="M14 2 7.3 8.7M14 2 9.6 14l-2.3-5.3L2 6.4z" /></S>
);
