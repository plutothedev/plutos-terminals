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
