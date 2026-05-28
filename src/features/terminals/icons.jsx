// (C)
// Colorful, cohesive Windows-style SVG icons approximating MobaXterm's toolbar /
// ribbon set — replaces emoji so the chrome reads as a native tool, not a web
// app. Each renders ~17px with fixed colours (independent of the chrome theme).
const S = ({ children, size = 17 }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" style={{ display: "block" }} aria-hidden="true">
    {children}
  </svg>
);

export const IconSession = ({ size }) => (
  <S size={size}>
    <rect x="1.5" y="2.3" width="13" height="8.4" rx="1.2" fill="#2f7fd6" />
    <rect x="3" y="3.8" width="10" height="5.4" rx="0.6" fill="#cfe7ff" />
    <rect x="5.5" y="10.9" width="5" height="1.5" fill="#2f7fd6" />
    <rect x="4" y="12.4" width="8" height="1.4" rx="0.7" fill="#2f7fd6" />
  </S>
);

export const IconServers = ({ size }) => (
  <S size={size}>
    {[2.1, 6.35, 10.6].map((y, i) => (
      <g key={y}>
        <rect x="2" y={y} width="12" height="3.3" rx="1" fill={i === 0 ? "#3fd0de" : "#2bb3c0"} />
        <circle cx="4" cy={y + 1.65} r="0.7" fill="#08363c" />
      </g>
    ))}
  </S>
);

export const IconTools = ({ size }) => (
  <S size={size}>
    <circle cx="10.7" cy="5.3" r="3.3" fill="none" stroke="#d8453b" strokeWidth="2.1" />
    <rect x="1.6" y="9.1" width="8.4" height="2.5" rx="1.25" transform="rotate(45 6 10.3)" fill="#d8453b" />
  </S>
);

export const IconGames = ({ size }) => (
  <S size={size}>
    <rect x="1.3" y="5" width="13.4" height="6.4" rx="3.2" fill="#7e57c2" />
    <circle cx="4.4" cy="8.2" r="0.95" fill="#fff" />
    <circle cx="6.3" cy="8.2" r="0.95" fill="#fff" />
    <circle cx="10.8" cy="7.3" r="0.95" fill="#fff" />
    <circle cx="11.7" cy="9.1" r="0.95" fill="#fff" />
  </S>
);

export const IconStar = ({ size }) => (
  <S size={size}>
    <path d="M8 1.5l1.95 3.95 4.35.63-3.15 3.07.74 4.35L8 11.4l-3.89 2.05.74-4.35L1.7 6.08l4.35-.63z" fill="#f5b400" />
  </S>
);

export const IconView = ({ size }) => (
  <S size={size}>
    <rect x="1.5" y="2.5" width="13" height="11" rx="1.2" fill="#3aa657" />
    <rect x="1.5" y="2.5" width="13" height="2.8" rx="1.2" fill="#2e8748" />
    <rect x="3" y="6.4" width="10" height="5.4" rx="0.6" fill="#dff5e6" />
  </S>
);

export const IconSplit = ({ size }) => (
  <S size={size}>
    <rect x="1.5" y="2.5" width="5.6" height="11" rx="1" fill="#2f7fd6" />
    <rect x="8.9" y="2.5" width="5.6" height="11" rx="1" fill="#7fb6ec" />
  </S>
);

export const IconMultiExec = ({ size }) => (
  <S size={size}>
    <g stroke="#5b8def" strokeWidth="1.5" fill="none" strokeLinecap="round">
      <path d="M8 13.5V8" />
      <path d="M8 8L3.6 3.6" />
      <path d="M8 8l4.4-4.4" />
    </g>
    <circle cx="8" cy="13.5" r="1.7" fill="#5b8def" />
    <circle cx="3.2" cy="3.2" r="1.7" fill="#5b8def" />
    <circle cx="12.8" cy="3.2" r="1.7" fill="#5b8def" />
  </S>
);

export const IconTunneling = ({ size }) => (
  <S size={size}>
    <g fill="#e8862b">
      <path d="M2 4.4h7.2V2.6l4 3.2-4 3.2V7.2H2z" />
      <path d="M14 11.6H6.8v1.8l-4-3.2 4-3.2v1.8H14z" />
    </g>
  </S>
);

export const IconPackages = ({ size }) => (
  <S size={size}>
    <path d="M8 1.6l6 2.9v6.9l-6 2.9-6-2.9V4.5z" fill="#c5852a" />
    <path d="M8 1.6l6 2.9-6 2.9-6-2.9z" fill="#eab861" />
    <path d="M8 7.4v6.9l6-2.9V4.5z" fill="#b5762088" />
  </S>
);

export const IconSettings = ({ size }) => (
  <S size={size}>
    <g fill="#9aa0a6">
      {[0, 45, 90, 135].map((a) => (
        <rect key={a} x="6.8" y="0.7" width="2.4" height="14.6" rx="0.7" transform={`rotate(${a} 8 8)`} />
      ))}
      <circle cx="8" cy="8" r="4.7" />
    </g>
    <circle cx="8" cy="8" r="2" fill="#2a2a2a" />
  </S>
);

export const IconHelp = ({ size }) => (
  <S size={size}>
    <circle cx="8" cy="8" r="6.6" fill="#2f7fd6" />
    <text x="8" y="11.6" textAnchor="middle" fontSize="9.5" fontWeight="700" fill="#fff" fontFamily="system-ui, sans-serif">?</text>
  </S>
);

export const IconMoon = ({ size }) => (
  <S size={size}>
    <path d="M9.6 1.6a6.4 6.4 0 1 0 4.8 10.5A5.1 5.1 0 0 1 9.6 1.6z" fill="#cdd6e6" />
  </S>
);

export const IconSun = ({ size }) => (
  <S size={size}>
    <circle cx="8" cy="8" r="3.2" fill="#f5b400" />
    <g stroke="#f5b400" strokeWidth="1.5" strokeLinecap="round">
      {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => {
        const r = (a * Math.PI) / 180;
        const x1 = 8 + Math.cos(r) * 5, y1 = 8 + Math.sin(r) * 5;
        const x2 = 8 + Math.cos(r) * 6.8, y2 = 8 + Math.sin(r) * 6.8;
        return <line key={a} x1={x1} y1={y1} x2={x2} y2={y2} />;
      })}
    </g>
  </S>
);

export const IconExit = ({ size }) => (
  <S size={size}>
    <path d="M8 7.5a5.4 5.4 0 1 1-3.2-1" fill="none" stroke="#e0524a" strokeWidth="1.8" strokeLinecap="round" transform="rotate(45 8 8.5)" />
    <rect x="7.1" y="1.8" width="1.8" height="5.4" rx="0.9" fill="#e0524a" />
  </S>
);

export const IconFolder = ({ size }) => (
  <S size={size}>
    <path d="M1.6 4.1a1 1 0 0 1 1-1h3.1l1.2 1.5H13.4a1 1 0 0 1 1 1v6.3a1 1 0 0 1-1 1H2.6a1 1 0 0 1-1-1z" fill="#e0a82e" />
    <path d="M1.6 5.6h12.8v5.6a1 1 0 0 1-1 1H2.6a1 1 0 0 1-1-1z" fill="#f7c948" />
  </S>
);
