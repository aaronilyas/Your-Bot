import type { ReactNode } from 'react';
import type { Look } from './appearance';

/*
 * Decorative seasonal illustrations. They sit behind the main pane only and never take pointer input or focus.
 * The whole layer is faded as one group (CSS `opacity: var(--art-opacity)`), and every shape uses one of the three
 * palette art colours (.a1/.a2/.a3), so tests/appearance.test.ts can prove text stays at 4.5:1 wherever it shows.
 */

const half: [number, number][] = [[50, 4], [57, 22], [70, 15], [67, 37], [88, 30], [80, 47], [97, 54], [77, 63], [82, 79], [57, 70], [53, 86]];
const MAPLE = `M${[...half, ...half.slice().reverse().map(([x, y]) => [100 - x, y] as [number, number])].map(([x, y]) => `${x} ${y}`).join(' L')} Z`;
function Leaf({ x, y, size, rotate, tone }: { x: number; y: number; size: number; rotate: number; tone: 1 | 2 | 3 }) {
  return <g transform={`translate(${x} ${y}) rotate(${rotate}) scale(${size / 100}) translate(-50 -50)`}><path className={`a${tone}`} d={MAPLE} /><path className="s3" d="M50 84 L50 100" strokeWidth={4} /></g>;
}
function Flake({ x, y, r }: { x: number; y: number; r: number }) {
  return <g className="s2" transform={`translate(${x} ${y})`} strokeWidth={r / 6}>{[0, 60, 120].map(angle => <path key={angle} transform={`rotate(${angle})`} d={`M0 ${-r} V${r} M${-r / 3} ${-r * 0.7} L0 ${-r * 0.45} L${r / 3} ${-r * 0.7} M${-r / 3} ${r * 0.7} L0 ${r * 0.45} L${r / 3} ${r * 0.7}`} />)}</g>;
}
function Blossom({ x, y, r, tone }: { x: number; y: number; r: number; tone: 1 | 2 }) {
  return <g transform={`translate(${x} ${y})`}>{[0, 72, 144, 216, 288].map(angle => <ellipse key={angle} className={`a${tone}`} transform={`rotate(${angle}) translate(0 ${-r * 0.62})`} rx={r * 0.42} ry={r * 0.62} />)}<circle className={`a${tone === 1 ? 2 : 1}`} r={r * 0.28} /></g>;
}
function Tulip({ x, height, tone }: { x: number; height: number; tone: 1 | 2 }) {
  const top = 300 - height;
  return <g><path className="s3" d={`M${x} 300 C${x - 6} ${top + 60} ${x + 4} ${top + 30} ${x} ${top + 14}`} strokeWidth={5} /><path className="a3" d={`M${x} 290 C${x - 34} ${270 - height / 3} ${x - 30} ${280 - height / 2} ${x - 4} ${280 - height / 2.2} Z`} /><path className={`a${tone}`} d={`M${x - 16} ${top + 18} C${x - 18} ${top - 4} ${x - 10} ${top - 12} ${x - 8} ${top - 6} L${x} ${top + 4} L${x + 8} ${top - 6} C${x + 10} ${top - 12} ${x + 18} ${top - 4} ${x + 16} ${top + 18} C${x + 12} ${top + 30} ${x - 12} ${top + 30} ${x - 16} ${top + 18} Z`} /></g>;
}

const PIECES: Record<Exclude<Look, 'classic'>, { topRight: ReactNode; bottomLeft: ReactNode; bottomRight: ReactNode }> = {
  autumn: {
    topRight: <svg viewBox="0 0 320 300">{[[250, 40, 70, 20, 2], [180, 110, 52, -35, 1], [270, 160, 46, 50, 3], [120, 40, 38, 15, 1], [215, 235, 40, -60, 2]].map(([x, y, s, r, t], i) => <Leaf key={i} x={x} y={y} size={s} rotate={r} tone={t as 1 | 2 | 3} />)}</svg>,
    bottomLeft: <svg viewBox="0 0 360 260"><ellipse className="a1" cx={130} cy={236} rx={120} ry={22} />{[[60, 205, 62, -20, 2], [130, 200, 58, 30, 3], [200, 218, 50, -50, 1], [95, 235, 54, 75, 1], [30, 238, 46, 10, 3], [165, 238, 44, -10, 2]].map(([x, y, s, r, t], i) => <Leaf key={i} x={x} y={y} size={s} rotate={r} tone={t as 1 | 2 | 3} />)}</svg>,
    bottomRight: <svg viewBox="0 0 220 220">{[[150, 80, 44, 120, 1], [90, 150, 36, -80, 3]].map(([x, y, s, r, t], i) => <Leaf key={i} x={x} y={y} size={s} rotate={r} tone={t as 1 | 2 | 3} />)}<g transform="translate(170 180)"><ellipse className="a2" rx={13} ry={16} /><path className="a3" d="M-16 -8 C-16 -22 16 -22 16 -8 Z" /><path className="s3" d="M0 -20 L3 -28" strokeWidth={3} /></g></svg>,
  },
  winter: {
    topRight: <svg viewBox="0 0 320 300">{[[260, 50, 26], [180, 90, 18], [285, 150, 14], [120, 40, 12], [220, 200, 20], [150, 170, 10], [300, 250, 12]].map(([x, y, r], i) => <Flake key={i} x={x} y={y} r={r} />)}</svg>,
    bottomLeft: <svg viewBox="0 0 360 260">{[[70, 150, 1], [140, 120, 1.3], [205, 160, 0.9]].map(([x, y, k], i) => <g key={i} transform={`translate(${x} ${y}) scale(${k})`}><path className="a3" d="M-4 70 H4 V86 H-4 Z" /><path className="a2 s3" strokeWidth={2} d="M0 -40 L22 -6 H12 L30 24 H16 L36 58 H-36 L-16 24 H-30 L-12 -6 H-22 Z" /><path className="a1" d="M0 -40 L10 -24 L4 -20 L0 -26 L-4 -20 L-10 -24 Z M-22 -6 H22 L16 2 H-16 Z" /></g>)}<ellipse className="a1 s2" strokeWidth={3} cx={140} cy={236} rx={130} ry={20} />{[[40, 40, 10], [290, 60, 14], [300, 170, 9]].map(([x, y, r], i) => <Flake key={i} x={x} y={y} r={r} />)}</svg>,
    bottomRight: <svg viewBox="0 0 260 320"><ellipse className="a1 s2" strokeWidth={3} cx={130} cy={292} rx={118} ry={22} />
      <path className="s3" strokeWidth={5} d="M88 166 L40 130 M50 138 L36 144 M172 166 L218 124 M206 134 L222 138" />
      <circle className="a1 s2" strokeWidth={4} cx={130} cy={242} r={52} /><circle className="a1 s2" strokeWidth={4} cx={130} cy={160} r={40} /><circle className="a1 s2" strokeWidth={4} cx={130} cy={96} r={30} />
      <path className="a2" d="M98 120 C112 132 150 132 162 120 L164 132 C150 142 112 142 96 132 Z M146 130 L160 168 L146 170 L136 134 Z" />
      <path className="a3" d="M102 72 H158 V66 H146 V30 H114 V66 H102 Z" /><path className="a2" d="M114 58 H146 V66 H114 Z" />
      <circle className="a3" cx={120} cy={92} r={3.5} /><circle className="a3" cx={140} cy={92} r={3.5} /><path className="a2" d="M130 100 L156 106 L130 108 Z" />
      {[148, 164, 180].map(y => <circle key={y} className="a3" cx={130} cy={y} r={4} />)}</svg>,
  },
  spring: {
    topRight: <svg viewBox="0 0 320 300"><path className="s3" strokeWidth={7} d="M320 20 C260 40 210 70 150 130 M250 52 C240 90 250 120 262 150 M200 92 C170 80 140 82 110 90" />
      {[[150, 130, 20, 1], [262, 150, 22, 2], [110, 90, 18, 2], [220, 60, 16, 1], [180, 110, 14, 2], [290, 40, 18, 1], [250, 205, 14, 1]].map(([x, y, r, t], i) => <Blossom key={i} x={x} y={y} r={r} tone={t as 1 | 2} />)}</svg>,
    bottomLeft: <svg viewBox="0 0 360 300"><ellipse className="a3" cx={150} cy={292} rx={140} ry={12} />{[[40, 150, 1], [90, 190, 2], [140, 130, 1], [195, 170, 2], [250, 110, 1]].map(([x, h, t]) => <Tulip key={x} x={x} height={h} tone={t as 1 | 2} />)}</svg>,
    bottomRight: <svg viewBox="0 0 220 220">{[[150, 60, 16, 2], [80, 130, 12, 1], [180, 170, 14, 1]].map(([x, y, r, t], i) => <Blossom key={i} x={x} y={y} r={r} tone={t as 1 | 2} />)}</svg>,
  },
  summer: {
    topRight: <svg viewBox="0 0 320 300"><g transform="translate(230 90)">{Array.from({ length: 12 }, (_, i) => <path key={i} className="s1" strokeWidth={8} transform={`rotate(${i * 30})`} d="M0 -70 V-96" />)}<circle className="a1" r={56} /></g>
      <path className="s2" strokeWidth={5} d="M60 70 q14 -14 28 0 q14 -14 28 0 M110 140 q10 -10 20 0 q10 -10 20 0" /></svg>,
    bottomLeft: <svg viewBox="0 0 360 260">{[0, 1, 2].map(row => <path key={row} className="s2" strokeWidth={6} d={`M${row * 20} ${190 + row * 26} q30 -22 60 0 t60 0 t60 0 t60 0 t60 0`} />)}<g transform="translate(150 130)"><path className="a3" d="M-40 30 H40 L28 46 H-28 Z" /><path className="s3" strokeWidth={4} d="M0 30 V-50" /><path className="a1" d="M4 -46 L44 24 H4 Z" /><path className="a2" d="M-4 -30 L-34 24 H-4 Z" /></g></svg>,
    bottomRight: <svg viewBox="0 0 260 260"><ellipse className="a3" cx={130} cy={214} rx={118} ry={26} /><g transform="translate(140 200)"><path className="s3" strokeWidth={7} d="M0 0 C6 -50 2 -90 -10 -130" /><path className="a2" d="M-10 -130 C-50 -150 -80 -130 -90 -110 C-60 -128 -30 -126 -10 -130 Z M-10 -130 C30 -156 64 -140 76 -120 C44 -136 16 -132 -10 -130 Z M-10 -130 C-30 -170 -10 -190 10 -196 C-6 -172 -10 -150 -10 -130 Z M-10 -130 C-40 -110 -46 -84 -44 -66 C-30 -92 -22 -112 -10 -130 Z" /></g></svg>,
  },
};

export function SeasonArt({ look }: { look: Look }) {
  if (look === 'classic') return null;
  const art = PIECES[look];
  return <div className={`season-art ${look}`} aria-hidden="true">
    <div className="art-piece top-right">{art.topRight}</div>
    <div className="art-piece bottom-left">{art.bottomLeft}</div>
    <div className="art-piece bottom-right">{art.bottomRight}</div>
  </div>;
}
