/** Display preferences shared by the main process (which stores them) and the renderer (which applies them). */
export const COLOR_MODES = ['system', 'light', 'dark'] as const;
export const SEASONS = ['spring', 'summer', 'autumn', 'winter'] as const;
export const THEMES = ['seasonal', ...SEASONS, 'classic'] as const;
export type ColorMode = typeof COLOR_MODES[number];
export type Season = typeof SEASONS[number];
export type ThemeChoice = typeof THEMES[number];
export interface AppearancePrefs {
  colorMode: ColorMode;
  /** `seasonal` follows the calendar; a season name pins it; `classic` is the plain neutral look. */
  theme: ThemeChoice;
  /** Decorative seasonal illustration behind the main pane. */
  backgroundArt: boolean;
}
export const DEFAULT_APPEARANCE: Readonly<AppearancePrefs> = Object.freeze({ colorMode: 'system', theme: 'seasonal', backgroundArt: true });

/** Accepts only a complete, exact preferences object; anything else yields undefined. */
export function parseAppearance(value: unknown): AppearancePrefs | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join() !== 'backgroundArt,colorMode,theme') return undefined;
  const { colorMode, theme, backgroundArt } = record;
  if (!(COLOR_MODES as readonly unknown[]).includes(colorMode) || !(THEMES as readonly unknown[]).includes(theme) || typeof backgroundArt !== 'boolean') return undefined;
  return { colorMode: colorMode as ColorMode, theme: theme as ThemeChoice, backgroundArt };
}
