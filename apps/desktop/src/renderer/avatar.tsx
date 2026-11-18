/** Deep tones so white initials stay at WCAG AA contrast in every theme. */
export const AVATAR_COLOURS = ['#c2410c', '#b91c1c', '#be185d', '#7e22ce', '#4338ca', '#1d4ed8', '#0e7490', '#0f766e', '#15803d', '#a16207', '#57534e'] as const;
function hash(text: string): number { let h = 0; for (const char of text) h = (h * 31 + char.codePointAt(0)!) >>> 0; return h; }
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? [words[0], words[1]].map(word => [...word][0]) : [...(words[0] ?? '?')].slice(0, 1);
  return letters.join('').toUpperCase() || '?';
}
export function BotAvatar({ id, name, size = 'md' }: { id: string; name: string; size?: 'sm' | 'md' | 'lg' | 'xl' }) {
  return <span className={`bot-avatar ${size} tone-${hash(id) % AVATAR_COLOURS.length}`} aria-hidden="true">{initials(name)}</span>;
}
