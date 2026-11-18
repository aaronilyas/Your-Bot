import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_APPEARANCE, parseAppearance, type AppearancePrefs, type Season, type ThemeChoice } from '../shared/appearance';

export { DEFAULT_APPEARANCE, type AppearancePrefs, type ColorMode, type Season, type ThemeChoice } from '../shared/appearance';
export type Mode = 'light' | 'dark';
export type Look = Season | 'classic';

/**
 * Every colour the interface uses. Text colours are checked (tests/appearance.test.ts) against every surface they sit
 * on, including the canvas with the seasonal art blended in at `artOpacity`, so the art can never hide text or controls.
 */
export interface Palette {
  canvas: string; sidebar: string; panel: string; surface: string; hover: string; selected: string; border: string; field: string;
  text: string; muted: string; accent: string; onAccent: string; inverse: string; onInverse: string;
  good: string; warn: string; bad: string; focus: string;
  /** Art colours (light, mid, dark) and how strongly they are blended into the canvas. */
  art: [string, string, string]; artOpacity: number;
}

const classicLight: Palette = { canvas: '#fcfcfc', sidebar: '#f5f5f5', panel: '#fafafa', surface: '#efefef', hover: '#ebebeb', selected: '#e3e3e3', border: '#e2e2e2', field: '#ffffff', text: '#141414', muted: '#5f5f5f', accent: '#1f63d8', onAccent: '#ffffff', inverse: '#141414', onInverse: '#ffffff', good: '#126530', warn: '#794f00', bad: '#a72127', focus: '#1f63d8', art: ['#dddddd', '#c4c4c4', '#a8a8a8'], artOpacity: 0 };
const classicDark: Palette = { canvas: '#141414', sidebar: '#1b1b1b', panel: '#181818', surface: '#262626', hover: '#2b2b2b', selected: '#333333', border: '#2e2e2e', field: '#1f1f1f', text: '#f2f2f2', muted: '#a8a8a8', accent: '#6ea8ff', onAccent: '#0b1730', inverse: '#f2f2f2', onInverse: '#141414', good: '#5ccf86', warn: '#e9b949', bad: '#ff7b7b', focus: '#6ea8ff', art: ['#444444', '#555555', '#666666'], artOpacity: 0 };

export const PALETTES: Record<Look, Record<Mode, Palette>> = {
  classic: { light: classicLight, dark: classicDark },
  spring: {
    light: { canvas: '#fbfcf8', sidebar: '#f2f6ec', panel: '#f7faf3', surface: '#e8efe0', hover: '#e3ebd9', selected: '#d9e6cc', border: '#dce5d2', field: '#ffffff', text: '#18230f', muted: '#4f5e44', accent: '#246434', onAccent: '#ffffff', inverse: '#1d3322', onInverse: '#f6fbf2', good: '#126530', warn: '#794f00', bad: '#a72127', focus: '#246434', art: ['#f6b8cf', '#e886ab', '#8fc58a'], artOpacity: 0.28 },
    dark: { canvas: '#131912', sidebar: '#10150f', panel: '#121811', surface: '#1f281d', hover: '#253023', selected: '#2c3a29', border: '#2a3527', field: '#182016', text: '#ecf4e7', muted: '#a9baa1', accent: '#94d98f', onAccent: '#10240f', inverse: '#ecf4e7', onInverse: '#131912', good: '#7fd88a', warn: '#e6c160', bad: '#ff8a9a', focus: '#94d98f', art: ['#5e3446', '#7a3f58', '#2f5a2c'], artOpacity: 0.55 },
  },
  summer: {
    light: { canvas: '#fbfaf4', sidebar: '#f3f0e2', panel: '#f8f6ec', surface: '#ebe7d5', hover: '#e6e1cc', selected: '#dcd6bb', border: '#e0dbc6', field: '#ffffff', text: '#1d1a0f', muted: '#5a543d', accent: '#0e6f74', onAccent: '#ffffff', inverse: '#123b40', onInverse: '#f4fbfb', good: '#126530', warn: '#794f00', bad: '#a72127', focus: '#0e6f74', art: ['#f7d36b', '#7cc8dd', '#e5c88e'], artOpacity: 0.3 },
    dark: { canvas: '#0f191b', sidebar: '#0c1416', panel: '#0e1719', surface: '#1a2a2d', hover: '#203235', selected: '#26393d', border: '#233437', field: '#132022', text: '#e6f3f2', muted: '#9ebab8', accent: '#5fd3c6', onAccent: '#08201e', inverse: '#e6f3f2', onInverse: '#0f191b', good: '#72d68a', warn: '#ecc35a', bad: '#ff8b8b', focus: '#5fd3c6', art: ['#6b5521', '#1f5664', '#5c4a2a'], artOpacity: 0.55 },
  },
  autumn: {
    light: { canvas: '#fdf9f3', sidebar: '#f6eee2', panel: '#faf4eb', surface: '#efe4d4', hover: '#eadcc8', selected: '#e3d1b8', border: '#e6d9c6', field: '#ffffff', text: '#2a1a0e', muted: '#664c36', accent: '#963c0b', onAccent: '#ffffff', inverse: '#3a2414', onInverse: '#fff8ef', good: '#126530', warn: '#794f00', bad: '#a72127', focus: '#963c0b', art: ['#f0b05a', '#e07a3c', '#c4553a'], artOpacity: 0.26 },
    dark: { canvas: '#1b1510', sidebar: '#16110c', panel: '#19130e', surface: '#2a2019', hover: '#31261d', selected: '#3b2d21', border: '#35291f', field: '#211912', text: '#f6ebdf', muted: '#c2ab94', accent: '#f2a35e', onAccent: '#271505', inverse: '#f6ebdf', onInverse: '#1b1510', good: '#93d27c', warn: '#f0c260', bad: '#ff8f7f', focus: '#f2a35e', art: ['#6e4a1c', '#7a3f1e', '#6b2c22'], artOpacity: 0.6 },
  },
  winter: {
    light: { canvas: '#f7fafd', sidebar: '#edf2f8', panel: '#f3f7fb', surface: '#e3ebf4', hover: '#dce6f1', selected: '#d0dded', border: '#d9e3ee', field: '#ffffff', text: '#0e1b2a', muted: '#4a5c70', accent: '#1956a8', onAccent: '#ffffff', inverse: '#13243a', onInverse: '#f4f8fc', good: '#126530', warn: '#794f00', bad: '#a72127', focus: '#1956a8', art: ['#ffffff', '#a9c3e0', '#6f8fb5'], artOpacity: 0.32 },
    dark: { canvas: '#0e151e', sidebar: '#0b1118', panel: '#0d131b', surface: '#19232f', hover: '#1f2b39', selected: '#253447', border: '#223042', field: '#121b26', text: '#e8eff8', muted: '#a0b1c5', accent: '#8cc3ff', onAccent: '#0a1a2c', inverse: '#e8eff8', onInverse: '#0e151e', good: '#74d39a', warn: '#ecc35a', bad: '#ff8c96', focus: '#8cc3ff', art: ['#3c4e64', '#2e4560', '#41566e'], artOpacity: 0.55 },
  },
};

/** Zones whose seasons are reversed (southern hemisphere). Anything else is treated as northern. */
const SOUTHERN = /^(Australia|Antarctica)\/|^Pacific\/(Auckland|Chatham|Fiji|Tongatapu|Apia|Noumea|Efate)$|^America\/(Argentina\/.*|Santiago|Sao_Paulo|Montevideo|Asuncion|La_Paz|Lima|Punta_Arenas|Buenos_Aires)$|^Africa\/(Johannesburg|Maputo|Harare|Lusaka|Windhoek|Gaborone|Maseru|Mbabane|Blantyre|Lubumbashi)$|^Indian\/(Mauritius|Reunion|Antananarivo)$|^Atlantic\/(Stanley|South_Georgia)$/;
export function seasonFor(date: Date, timeZone?: string): Season {
  const month = date.getMonth(); // 0 = January
  const north: Season = month <= 1 || month === 11 ? 'winter' : month <= 4 ? 'spring' : month <= 7 ? 'summer' : 'autumn';
  if (!timeZone || !SOUTHERN.test(timeZone)) return north;
  return ({ winter: 'summer', summer: 'winter', spring: 'autumn', autumn: 'spring' } as const)[north];
}
const localZone = (): string | undefined => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return undefined; } };
export function lookFor(theme: ThemeChoice, date = new Date(), timeZone = localZone()): Look {
  return theme === 'seasonal' ? seasonFor(date, timeZone) : theme;
}
export const SEASON_LABELS: Record<Look, string> = { spring: 'Spring', summer: 'Summer', autumn: 'Fall', winter: 'Winter', classic: 'Classic' };

const prefersDark = (): boolean => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches;
export function modeFor(prefs: AppearancePrefs): Mode { return prefs.colorMode === 'system' ? prefersDark() ? 'dark' : 'light' : prefs.colorMode; }

const kebab = (key: string) => key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
/** Writes the palette as CSS custom properties through the CSSOM (allowed by the renderer's style-src 'self' policy). */
export function applyAppearance(root: HTMLElement, look: Look, mode: Mode, showArt: boolean): void {
  const palette = PALETTES[look][mode];
  for (const [key, value] of Object.entries(palette)) {
    if (key === 'art') (value as string[]).forEach((colour, index) => root.style.setProperty(`--art-${index + 1}`, colour));
    else root.style.setProperty(`--${kebab(key)}`, String(value));
  }
  root.style.colorScheme = mode;
  root.dataset.mode = mode;
  root.dataset.look = look;
  root.dataset.art = showArt ? 'on' : 'off';
}

export interface AppearanceStorage {
  loadAppearance?(): Promise<AppearancePrefs | undefined>;
  saveAppearance?(prefs: AppearancePrefs): Promise<boolean>;
}
const STORAGE_KEY = 'your-bot.appearance';
/** Browser demo / development fallback when no host storage is available. */
const localStorageBackend: Required<AppearanceStorage> = {
  async loadAppearance() { try { return parseAppearance(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null')); } catch { return undefined; } },
  async saveAppearance(prefs) { try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs)); return true; } catch { return false; } },
};

export interface Appearance { prefs: AppearancePrefs; look: Look; mode: Mode; showArt: boolean; update(patch: Partial<AppearancePrefs>): void; }
/** Loads, applies and persists the display preferences. Re-evaluates the season hourly and follows OS light/dark changes. */
export function useAppearance(storage: AppearanceStorage): Appearance {
  const backend = typeof storage.loadAppearance === 'function' && typeof storage.saveAppearance === 'function' ? storage as Required<AppearanceStorage> : localStorageBackend;
  const [prefs, setPrefs] = useState<AppearancePrefs>(DEFAULT_APPEARANCE);
  const latest = useRef(prefs); latest.current = prefs;
  const touched = useRef(false);
  const [, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    // A choice made before the stored value arrives wins over it.
    backend.loadAppearance().then(stored => { if (live && stored && !touched.current) setPrefs(stored); }).catch(() => {});
    return () => { live = false; };
  }, [backend]);
  useEffect(() => {
    const timer = setInterval(() => setTick(tick => tick + 1), 3600_000);
    const media = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : undefined;
    const changed = () => setTick(tick => tick + 1);
    media?.addEventListener?.('change', changed);
    return () => { clearInterval(timer); media?.removeEventListener?.('change', changed); };
  }, []);
  const look = lookFor(prefs.theme);
  const mode = modeFor(prefs);
  const showArt = prefs.backgroundArt && look !== 'classic';
  useEffect(() => { applyAppearance(document.documentElement, look, mode, showArt); }, [look, mode, showArt]);
  const update = useCallback((patch: Partial<AppearancePrefs>) => {
    touched.current = true;
    const next = { ...latest.current, ...patch };
    latest.current = next;
    setPrefs(next);
    void backend.saveAppearance(next).catch(() => false);
  }, [backend]);
  return { prefs, look, mode, showArt, update };
}
