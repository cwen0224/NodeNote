export const MAX_FOLDER_DEPTH = 7;

const FOLDER_THEMES = [
  {
    name: 'root',
    accent: '#58a6ff',
    bgColor: '#0d1117',
    gridColor: 'rgba(255, 255, 255, 0.20)',
    glassBg: 'rgba(20, 25, 35, 0.60)',
    glassBorder: 'rgba(255, 255, 255, 0.10)',
    nodeBg: 'rgba(30, 35, 45, 0.92)',
    folderNodeBg: 'rgba(25, 35, 50, 0.96)',
    folderNodeBorder: 'rgba(88, 166, 255, 0.38)',
    folderNodeHeader: 'rgba(88, 166, 255, 0.12)',
  },
  {
    name: 'indigo',
    accent: '#7c9cff',
    bgColor: '#10111d',
    gridColor: 'rgba(124, 156, 255, 0.18)',
    glassBg: 'rgba(26, 29, 48, 0.64)',
    glassBorder: 'rgba(124, 156, 255, 0.12)',
    nodeBg: 'rgba(33, 37, 61, 0.94)',
    folderNodeBg: 'rgba(34, 40, 72, 0.96)',
    folderNodeBorder: 'rgba(124, 156, 255, 0.42)',
    folderNodeHeader: 'rgba(124, 156, 255, 0.13)',
  },
  {
    name: 'teal',
    accent: '#5eead4',
    bgColor: '#0e1718',
    gridColor: 'rgba(94, 234, 212, 0.16)',
    glassBg: 'rgba(18, 34, 35, 0.66)',
    glassBorder: 'rgba(94, 234, 212, 0.10)',
    nodeBg: 'rgba(24, 43, 46, 0.94)',
    folderNodeBg: 'rgba(22, 52, 54, 0.96)',
    folderNodeBorder: 'rgba(94, 234, 212, 0.40)',
    folderNodeHeader: 'rgba(94, 234, 212, 0.13)',
  },
  {
    name: 'green',
    accent: '#34d399',
    bgColor: '#101a16',
    gridColor: 'rgba(52, 211, 153, 0.16)',
    glassBg: 'rgba(18, 36, 28, 0.66)',
    glassBorder: 'rgba(52, 211, 153, 0.10)',
    nodeBg: 'rgba(24, 42, 34, 0.94)',
    folderNodeBg: 'rgba(20, 54, 41, 0.96)',
    folderNodeBorder: 'rgba(52, 211, 153, 0.40)',
    folderNodeHeader: 'rgba(52, 211, 153, 0.13)',
  },
  {
    name: 'amber',
    accent: '#f59e0b',
    bgColor: '#18130e',
    gridColor: 'rgba(245, 158, 11, 0.16)',
    glassBg: 'rgba(41, 31, 18, 0.66)',
    glassBorder: 'rgba(245, 158, 11, 0.10)',
    nodeBg: 'rgba(48, 37, 24, 0.94)',
    folderNodeBg: 'rgba(68, 46, 18, 0.96)',
    folderNodeBorder: 'rgba(245, 158, 11, 0.42)',
    folderNodeHeader: 'rgba(245, 158, 11, 0.13)',
  },
  {
    name: 'rose',
    accent: '#fb7185',
    bgColor: '#191014',
    gridColor: 'rgba(251, 113, 133, 0.16)',
    glassBg: 'rgba(40, 23, 29, 0.66)',
    glassBorder: 'rgba(251, 113, 133, 0.10)',
    nodeBg: 'rgba(49, 28, 37, 0.94)',
    folderNodeBg: 'rgba(70, 25, 40, 0.96)',
    folderNodeBorder: 'rgba(251, 113, 133, 0.42)',
    folderNodeHeader: 'rgba(251, 113, 133, 0.13)',
  },
  {
    name: 'violet',
    accent: '#c084fc',
    bgColor: '#15101a',
    gridColor: 'rgba(192, 132, 252, 0.16)',
    glassBg: 'rgba(34, 24, 43, 0.66)',
    glassBorder: 'rgba(192, 132, 252, 0.10)',
    nodeBg: 'rgba(44, 31, 56, 0.94)',
    folderNodeBg: 'rgba(58, 29, 78, 0.96)',
    folderNodeBorder: 'rgba(192, 132, 252, 0.42)',
    folderNodeHeader: 'rgba(192, 132, 252, 0.13)',
  },
  {
    name: 'sky',
    accent: '#60a5fa',
    bgColor: '#0f1420',
    gridColor: 'rgba(96, 165, 250, 0.16)',
    glassBg: 'rgba(21, 28, 42, 0.66)',
    glassBorder: 'rgba(96, 165, 250, 0.10)',
    nodeBg: 'rgba(28, 37, 54, 0.94)',
    folderNodeBg: 'rgba(24, 42, 70, 0.96)',
    folderNodeBorder: 'rgba(96, 165, 250, 0.42)',
    folderNodeHeader: 'rgba(96, 165, 250, 0.13)',
  },
];

function clampDepth(depth = 0) {
  const normalized = Number.isFinite(depth) ? Math.max(0, Math.floor(depth)) : 0;
  return Math.min(normalized, FOLDER_THEMES.length - 1);
}

export function getFolderTheme(depth = 0) {
  return FOLDER_THEMES[clampDepth(depth)];
}

export function folderThemeToCssVars(theme = getFolderTheme(0)) {
  return {
    '--bg-color': theme.bgColor,
    '--grid-color': theme.gridColor,
    '--glass-bg': theme.glassBg,
    '--glass-border': theme.glassBorder,
    '--accent': theme.accent,
    '--node-bg': theme.nodeBg,
    '--folder-node-bg': theme.folderNodeBg,
    '--folder-node-border': theme.folderNodeBorder,
    '--folder-node-header': theme.folderNodeHeader,
  };
}

