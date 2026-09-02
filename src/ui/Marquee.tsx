/**
 * Infinite marquee, in CSS.
 *
 * The design system specifies `react-fast-marquee`. That would be a third runtime dependency in a
 * project whose README and submission both state "no dependencies at runtime beyond React", and
 * falsifying a published claim to obtain a scrolling div is a bad trade. A duplicated track and one
 * `translate3d` keyframe get the same result: GPU-composited, no JavaScript on the main thread during
 * scroll, and nothing to audit.
 *
 * The duplicate copy is what makes the loop seamless — the track translates by exactly -50% and the
 * second copy has arrived where the first began. It carries `aria-hidden`, so a screen reader hears
 * the content once rather than twice.
 *
 * Motion is suppressed under `prefers-reduced-motion` in the stylesheet, which the design system's
 * own accessibility section requires. The content stays laid out and readable when it stops.
 */
import type { ReactNode } from 'react';

interface Props {
  /** Seconds for one complete pass. Lower is faster. */
  duration: number;
  /** `accent` is the acid-yellow band; `plain` sits on the page background. */
  variant?: 'accent' | 'plain';
  /** Announced to assistive technology in place of the scrolling text. */
  label: string;
  children: ReactNode;
}

export function Marquee({ duration, variant = 'plain', label, children }: Props) {
  return (
    <div className={`marquee ${variant}`} aria-label={label}>
      <div className="marquee-track" style={{ animationDuration: `${duration}s` }}>
        <div className="marquee-run">{children}</div>
        <div className="marquee-run" aria-hidden="true">
          {children}
        </div>
      </div>
    </div>
  );
}

/** One cell of a marquee: a figure and its label, or a bare symbol. */
export function MarqueeItem({ figure, children }: { figure?: string; children: ReactNode }) {
  return (
    <span className="marquee-item">
      {figure ? <b>{figure}</b> : null}
      {children}
    </span>
  );
}

/** The divider between marquee cells. Decorative, so it is hidden from assistive technology. */
export function MarqueeMark() {
  return (
    <span className="marquee-mark" aria-hidden="true">
      ✳
    </span>
  );
}
