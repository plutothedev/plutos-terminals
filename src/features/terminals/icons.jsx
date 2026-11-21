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
