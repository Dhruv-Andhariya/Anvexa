import type { ReactNode } from 'react';

/**
 * Empty-state illustrations, one per page, all in the same style: a soft cloud, a few motion ticks, and a floating
 * centrepiece that shows what the page is about. Drawn only with theme tokens, so they follow light and dark mode.
 * Decorative only (aria-hidden): the heading next to them carries the meaning.
 */

const C = {
  accent: 'var(--accent)',
  accentDeep: 'var(--accent-hover)',
  soft: 'var(--accent-soft)',
  /** a touch deeper than accent-soft, so the cloud stands out on tinted panels too */
  cloud: 'color-mix(in srgb, var(--tone-sky) 17%, var(--surface))',
  surface: 'var(--surface)',
  line: 'var(--border)',
  edge: 'var(--border-strong)',
  green: 'var(--tone-green)',
  greenSoft: 'var(--tone-green-soft)',
  amber: 'var(--tone-amber)',
  amberSoft: 'var(--tone-amber-soft)',
  sky: 'var(--tone-sky)',
  skySoft: 'var(--tone-sky-soft)',
  danger: 'var(--danger)',
};

type ArtProps = { className?: string };

/** The shared frame: cloud + ticks behind, the floating centrepiece, and anything that should stay still in front. */
function Scene({ className = '', children, front }: { className?: string; children: ReactNode; front?: ReactNode }) {
  return (
    <svg viewBox="0 0 260 140" className={className} aria-hidden="true" fill="none">
      <path
        d="M40 128c-14 0-24-10-24-22s10-22 23-22c3-18 18-31 36-31 9 0 17 3 23 8 7-17 24-29 44-29 25 0 46 19 48 44 15 1 27 13 27 28 0 13-11 24-25 24H40Z"
        fill={C.cloud}
      />
      <path d="M44 34l6 8M36 50l10 2M52 24l1 9" stroke={C.accent} strokeWidth="3" strokeLinecap="round" />
      <g className="animate-float">{children}</g>
      {front}
    </svg>
  );
}

/** Grey text placeholder line. */
const Line = ({ x, y, w, h = 5 }: { x: number; y: number; w: number; h?: number }) => <rect x={x} y={y} width={w} height={h} rx={h / 2} fill={C.line} />;

/** A head-and-shoulders avatar centred on (x, y) = the head's centre. */
function Person({ x, y, r = 9, fill = C.accent }: { x: number; y: number; r?: number; fill?: string }) {
  return (
    <g>
      <circle cx={x} cy={y} r={r} fill={fill} />
      <path d={`M${x - r * 1.8} ${y + r * 3}a${r * 1.8} ${r * 1.7} 0 0 1 ${r * 3.6} 0Z`} fill={fill} />
    </g>
  );
}

/** Jobs: a job card on the cloud and a paper plane flying off along a dashed trail. */
export function EmptyJobsArt({ className }: ArtProps) {
  return (
    <Scene
      className={className}
      front={
        <>
          <path d="M150 132c22-6 30-20 18-28-10-6-18 6-6 12 14 6 34-6 52-34" stroke={C.accent} strokeWidth="1.5" strokeDasharray="4 4" strokeLinecap="round" />
          <g transform="translate(206 26) rotate(-8)">
            <path d="M0 22 44 0 30 40 20 26Z" fill={C.accent} />
            <path d="M20 26 44 0 14 30Z" fill={C.accentDeep} />
          </g>
        </>
      }
    >
      <rect x="78" y="24" width="88" height="112" rx="8" fill={C.surface} stroke={C.edge} />
      <rect x="90" y="38" width="20" height="16" rx="3" fill={C.accent} />
      <path d="M96 38v-3a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v3" stroke={C.accent} strokeWidth="2" />
      <path d="M90 46h20" stroke={C.surface} strokeWidth="1.5" />
      <Line x={118} y={39} w={36} />
      <Line x={118} y={48} w={24} />
      <Line x={90} y={68} w={64} />
      <Line x={90} y={82} w={52} />
      <Line x={90} y={96} w={60} />
      <Line x={90} y={110} w={40} />
    </Scene>
  );
}

/** Publish: a careers-page window with a LIVE badge, and a megaphone broadcasting it. */
export function EmptyPublishArt({ className }: ArtProps) {
  return (
    <Scene
      className={className}
      front={
        <g transform="translate(176 30)">
          <path d="M6 22 34 8v40L6 34Z" fill={C.accent} />
          <rect x="0" y="20" width="10" height="16" rx="3" fill={C.accentDeep} />
          <path d="M10 36l4 14h6l-3-14" fill={C.accentDeep} />
          <path d="M44 18c6 6 6 14 0 20M52 12c10 9 10 23 0 32" stroke={C.accent} strokeWidth="2.5" strokeLinecap="round" />
        </g>
      }
    >
      <rect x="64" y="26" width="112" height="104" rx="8" fill={C.surface} stroke={C.edge} />
      <path d="M64 34a8 8 0 0 1 8-8h96a8 8 0 0 1 8 8v8H64Z" fill={C.soft} />
      <circle cx="74" cy="34" r="2.5" fill={C.danger} />
      <circle cx="82" cy="34" r="2.5" fill={C.amber} />
      <circle cx="90" cy="34" r="2.5" fill={C.green} />
      <rect x="76" y="52" width="30" height="12" rx="6" fill={C.greenSoft} />
      <circle cx="83" cy="58" r="2.5" fill={C.green} />
      <path d="M89 58h12" stroke={C.green} strokeWidth="2.5" strokeLinecap="round" />
      <Line x={76} y={72} w={84} h={7} />
      <Line x={76} y={86} w={64} />
      <Line x={76} y={96} w={74} />
      <rect x="76" y="110" width="40" height="10" rx="5" fill={C.accent} />
    </Scene>
  );
}

/** Applications: resumes dropping into an inbox tray, with an envelope arriving. */
export function EmptyApplicationsArt({ className }: ArtProps) {
  return (
    <Scene
      className={className}
      front={
        <>
          <path d="M80 98h28l6 10h32l6-10h28v24a8 8 0 0 1-8 8H88a8 8 0 0 1-8-8Z" fill={C.accent} />
          <path d="M80 98h28l6 10h32l6-10h28" stroke={C.accentDeep} strokeWidth="2" strokeLinejoin="round" />
          <g transform="translate(192 22) rotate(10)">
            <rect width="44" height="30" rx="4" fill={C.surface} stroke={C.accent} strokeWidth="2" />
            <path d="M2 3 22 18 42 3" stroke={C.accent} strokeWidth="2" strokeLinejoin="round" />
          </g>
          <path d="M186 60c-10 8-16 18-14 30" stroke={C.accent} strokeWidth="1.5" strokeDasharray="4 4" strokeLinecap="round" />
        </>
      }
    >
      <g transform="rotate(-8 112 70)">
        <rect x="88" y="30" width="56" height="74" rx="6" fill={C.surface} stroke={C.edge} />
        <circle cx="102" cy="46" r="6" fill={C.skySoft} stroke={C.sky} strokeWidth="1.5" />
        <Line x={112} y={42} w={24} />
        <Line x={98} y={60} w={38} />
        <Line x={98} y={70} w={30} />
      </g>
      <g transform="rotate(6 148 72)">
        <rect x="118" y="26" width="58" height="78" rx="6" fill={C.surface} stroke={C.edge} />
        <circle cx="133" cy="43" r="7" fill={C.soft} stroke={C.accent} strokeWidth="1.5" />
        <Line x={145} y={38} w={24} />
        <Line x={145} y={46} w={16} />
        <Line x={128} y={60} w={40} />
        <Line x={128} y={70} w={34} />
        <Line x={128} y={80} w={38} />
      </g>
    </Scene>
  );
}

/** Shortlisted: a candidate profile card with a gold star badge, more cards stacked behind. */
export function EmptyShortlistArt({ className }: ArtProps) {
  return (
    <Scene
      className={className}
      front={
        <g transform="translate(184 26)">
          <circle cx="16" cy="16" r="16" fill={C.amberSoft} stroke={C.amber} strokeWidth="2" />
          <path d="m16 7 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L16 21.3l-5.6 2.9 1.1-6.2L7 13.6l6.2-.9Z" fill={C.amber} />
        </g>
      }
    >
      <rect x="94" y="40" width="86" height="92" rx="8" fill={C.surface} stroke={C.edge} transform="rotate(8 137 86)" opacity="0.7" />
      <rect x="76" y="30" width="96" height="102" rx="8" fill={C.surface} stroke={C.edge} />
      <circle cx="124" cy="56" r="14" fill={C.soft} />
      <Person x={124} y={52} r={5} />
      <Line x={100} y={80} w={48} h={7} />
      <Line x={108} y={93} w={32} />
      <rect x="92" y="108" width="28" height="12" rx="6" fill={C.greenSoft} />
      <path d="m99 114 3 3 6-6" stroke={C.green} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="126" y="108" width="30" height="12" rx="6" fill={C.skySoft} />
    </Scene>
  );
}

/** Assessments: a clipboard checklist being ticked off, with a pencil. */
export function EmptyAssessmentArt({ className }: ArtProps) {
  const rows = [
    { y: 56, done: true, w: 44 },
    { y: 78, done: true, w: 36 },
    { y: 100, done: false, w: 40 },
  ];
  return (
    <Scene
      className={className}
      front={
        <g transform="translate(176 56) rotate(35)">
          <rect width="12" height="60" rx="3" fill={C.amber} />
          <rect width="12" height="10" rx="3" fill={C.danger} opacity="0.85" />
          <path d="M0 60h12l-6 12Z" fill={C.amberSoft} stroke={C.amber} strokeWidth="1.5" strokeLinejoin="round" />
        </g>
      }
    >
      <rect x="80" y="28" width="92" height="106" rx="8" fill={C.surface} stroke={C.edge} />
      <rect x="106" y="22" width="40" height="14" rx="4" fill={C.accent} />
      <circle cx="126" cy="29" r="2.5" fill={C.surface} />
      {rows.map((r) => (
        <g key={r.y}>
          <rect x="94" y={r.y - 7} width="14" height="14" rx="4" fill={r.done ? C.green : C.surface} stroke={r.done ? C.green : C.edge} strokeWidth="1.5" />
          {r.done && <path d={`m97.5 ${r.y} 3 3 5-6`} stroke={C.surface} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />}
          <Line x={116} y={r.y - 2.5} w={r.w} />
        </g>
      ))}
    </Scene>
  );
}

/** Group discussion: three people around a table of speech bubbles. */
export function EmptyDiscussionArt({ className }: ArtProps) {
  return (
    <Scene
      className={className}
      front={
        <>
          <Person x={86} y={92} r={9} fill={C.sky} />
          <Person x={130} y={82} r={10} fill={C.accent} />
          <Person x={174} y={92} r={9} fill={C.green} />
          <rect x="64" y="118" width="132" height="8" rx="4" fill={C.accentDeep} opacity="0.25" />
        </>
      }
    >
      <path d="M62 26h48a6 6 0 0 1 6 6v20a6 6 0 0 1-6 6H80l-8 8v-8h-10a6 6 0 0 1-6-6V32a6 6 0 0 1 6-6Z" fill={C.surface} stroke={C.edge} />
      <Line x={66} y={36} w={38} />
      <Line x={66} y={45} w={26} />
      <path d="M150 18h48a6 6 0 0 1 6 6v20a6 6 0 0 1-6 6h-10v8l-8-8h-30a6 6 0 0 1-6-6V24a6 6 0 0 1 6-6Z" fill={C.accent} />
      <circle cx="162" cy="34" r="3" fill={C.surface} />
      <circle cx="174" cy="34" r="3" fill={C.surface} />
      <circle cx="186" cy="34" r="3" fill={C.surface} />
    </Scene>
  );
}

/** Personal interview: a video call window with the candidate, a self-view, and call controls. */
export function EmptyInterviewArt({ className }: ArtProps) {
  return (
    <Scene
      className={className}
      front={
        <g transform="translate(190 30)">
          <path d="M4 0h32a4 4 0 0 1 4 4v18a4 4 0 0 1-4 4H18l-8 7v-7H4a4 4 0 0 1-4-4V4a4 4 0 0 1 4-4Z" fill={C.green} />
          <path d="m12 13 5 5 11-11" stroke={C.surface} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        </g>
      }
    >
      <rect x="66" y="26" width="124" height="94" rx="10" fill={C.surface} stroke={C.edge} />
      <rect x="74" y="34" width="108" height="66" rx="6" fill={C.soft} />
      <Person x={128} y={56} r={11} />
      <rect x="150" y="70" width="26" height="24" rx="4" fill={C.surface} stroke={C.edge} />
      <Person x={163} y={78} r={4} fill={C.sky} />
      <circle cx="114" cy="110" r="6" fill={C.line} />
      <circle cx="128" cy="110" r="6" fill={C.danger} />
      <path d="M125 110h6" stroke={C.surface} strokeWidth="2" strokeLinecap="round" />
      <circle cx="142" cy="110" r="6" fill={C.line} />
    </Scene>
  );
}

/** SQL questions: a database with a result table and a code tag. */
export function EmptySqlArt({ className }: ArtProps) {
  return (
    <Scene
      className={className}
      front={
        <g transform="translate(186 24)">
          <rect width="46" height="30" rx="8" fill={C.accent} />
          <path d="m16 9-6 6 6 6M30 9l6 6-6 6M25 8l-4 14" stroke={C.surface} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </g>
      }
    >
      <g>
        <path d="M66 42v62c0 6 13 11 30 11s30-5 30-11V42" fill={C.accent} />
        <ellipse cx="96" cy="42" rx="30" ry="11" fill={C.accentDeep} />
        <path d="M66 63c0 6 13 11 30 11s30-5 30-11M66 84c0 6 13 11 30 11s30-5 30-11" stroke={C.accentDeep} strokeWidth="2" />
      </g>
      <rect x="112" y="64" width="80" height="62" rx="6" fill={C.surface} stroke={C.edge} />
      <path d="M112 70a6 6 0 0 1 6-6h68a6 6 0 0 1 6 6v8h-80Z" fill={C.skySoft} />
      <path d="M112 78h80M112 94h80M112 110h80M138 64v62M164 64v62" stroke={C.line} />
    </Scene>
  );
}

/** Team: a small group of people with an invite badge. */
export function EmptyTeamArt({ className }: ArtProps) {
  return (
    <Scene
      className={className}
      front={
        <g transform="translate(176 36)">
          <circle cx="15" cy="15" r="15" fill={C.green} />
          <path d="M15 8v14M8 15h14" stroke={C.surface} strokeWidth="2.5" strokeLinecap="round" />
        </g>
      }
    >
      <rect x="62" y="40" width="136" height="88" rx="10" fill={C.surface} stroke={C.edge} />
      <circle cx="96" cy="72" r="16" fill={C.skySoft} />
      <Person x={96} y={68} r={6} fill={C.sky} />
      <circle cx="130" cy="66" r="20" fill={C.soft} />
      <Person x={130} y={61} r={8} />
      <circle cx="164" cy="72" r="16" fill={C.greenSoft} />
      <Person x={164} y={68} r={6} fill={C.green} />
      <Line x={104} y={104} w={52} h={7} />
      <Line x={114} y={116} w={32} />
    </Scene>
  );
}

/** Companies (platform admin): an office building with a flag. */
export function EmptyCompaniesArt({ className }: ArtProps) {
  return (
    <Scene
      className={className}
      front={
        <g transform="translate(150 6)">
          <path d="M2 4v30" stroke={C.accentDeep} strokeWidth="2" strokeLinecap="round" />
          <path d="M3 4h22l-5 7 5 7H3Z" fill={C.green} />
        </g>
      }
    >
      <rect x="90" y="40" width="72" height="92" rx="6" fill={C.surface} stroke={C.edge} />
      <rect x="150" y="34" width="4" height="8" fill={C.edge} />
      {[54, 72, 90].map((y) =>
        [102, 120, 138].map((x) => <rect key={`${x}-${y}`} x={x} y={y} width="12" height="10" rx="2" fill={(x + y) % 3 ? C.soft : C.accent} />),
      )}
      <rect x="116" y="110" width="20" height="22" rx="3" fill={C.accent} />
      <rect x="62" y="80" width="28" height="52" rx="4" fill={C.surface} stroke={C.edge} />
      <path d="M70 92h12M70 104h12M70 116h12" stroke={C.line} strokeWidth="5" strokeLinecap="round" />
    </Scene>
  );
}
