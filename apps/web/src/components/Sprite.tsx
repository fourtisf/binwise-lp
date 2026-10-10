/** SVG symbol sprite from the prototype. Icons reference it with <use href="#i-…"/>. */
export function Sprite() {
  return (
      <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
      <symbol id="i-mark" viewBox="0 0 18 18"><rect x="1.5" y="9" width="3" height="6.5" rx="1.2" fill="#0A0B12" opacity=".45"/><rect x="5.6" y="5" width="3" height="10.5" rx="1.2" fill="#0A0B12" opacity=".75"/><rect x="9.7" y="2" width="3" height="13.5" rx="1.2" fill="#0A0B12"/><rect x="13.8" y="7" width="3" height="8.5" rx="1.2" fill="#0A0B12" opacity=".6"/></symbol>
      <symbol id="i-home" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="6" height="8" rx="1.5"/><rect x="11" y="3" width="6" height="5" rx="1.5"/><rect x="11" y="10" width="6" height="7" rx="1.5"/><rect x="3" y="13" width="6" height="4" rx="1.5"/></symbol>
      <symbol id="i-pools" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M4 16V9M8 16V5M12 16v-8M16 16V3"/></symbol>
      <symbol id="i-pos" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><circle cx="10" cy="10" r="7"/><path d="M10 3v7l5 4"/></symbol>
      <symbol id="i-strat" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M3 6h8M15 6h2M3 14h2M9 14h8"/><circle cx="13" cy="6" r="2"/><circle cx="7" cy="14" r="2"/></symbol>
      <symbol id="i-act" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M2.5 10h3l2.5-6 4 12 2.5-6h3"/></symbol>
      <symbol id="i-check" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3.5 8.5l3 3 6-7"/></symbol>
      <symbol id="i-spin" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M8 2a6 6 0 1 1-6 6"/></symbol>
      <symbol id="i-dot" viewBox="0 0 16 16"><circle cx="8" cy="8" r="2.5" fill="currentColor"/></symbol>
      <symbol id="i-plus" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M8 3v10M3 8h10"/></symbol>
      <symbol id="i-swap" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M3 5h9l-2.5-2.5M13 11H4l2.5 2.5"/></symbol>
      <symbol id="i-exit" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M10 3h3v10h-3M7 5L4 8l3 3M4 8h7"/></symbol>
      <symbol id="i-comp" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M13 8a5 5 0 1 1-1.5-3.5M13 3v3h-3"/></symbol>
      <symbol id="i-search" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/></symbol>
      <symbol id="i-x" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="M4 4l8 8M12 4l-8 8"/></symbol>
      <symbol id="i-pause" viewBox="0 0 16 16" fill="currentColor"><rect x="4" y="3" width="3" height="10" rx="1"/><rect x="9" y="3" width="3" height="10" rx="1"/></symbol>
      <symbol id="i-play" viewBox="0 0 16 16" fill="currentColor"><path d="M5 3.5v9l7.5-4.5z"/></symbol>
      <symbol id="i-chev" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M6 4l4 4-4 4"/></symbol>
      <symbol id="i-updown" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M5 6l3-3 3 3M5 10l3 3 3-3"/></symbol>
      <symbol id="i-lock" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="3.5" y="7" width="9" height="6.5" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 015 0v2"/></symbol>
      <symbol id="i-bolt" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"><path d="M9 2L3.5 9H8l-1 5 5.5-7H8z"/></symbol>
      </svg>
  );
}

export type IconId =
  | 'i-mark' | 'i-home' | 'i-pools' | 'i-pos' | 'i-strat' | 'i-act' | 'i-check' | 'i-spin' | 'i-dot'
  | 'i-plus' | 'i-swap' | 'i-exit' | 'i-comp' | 'i-search' | 'i-x' | 'i-pause' | 'i-play' | 'i-chev'
  | 'i-updown' | 'i-lock' | 'i-bolt';

export function Icon({ id, className }: { id: IconId; className?: string }) {
  return (
    <svg className={className}>
      <use href={'#' + id} />
    </svg>
  );
}
