import markSvg from '../assets/brand/mark.svg?raw';
import mascotSvg from '../assets/brand/mascot.svg?raw';
import wordmarkSvg from '../assets/brand/wordmark.svg?raw';

/**
 * Brand artwork is inlined so that it can pick up the theme's colors through CSS variables. The
 * markup comes from files in this repository, at build time, never from anything a user provides.
 */
function InlineSvg({ svg, className, label }: { svg: string; className: string; label?: string }) {
  return (
    <span
      className={className}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

/** The cat's head on its own. Use it where space is tight, such as on image placeholders. */
export function BrandMark({ size = 28, label }: { size?: number; label?: string }) {
  return (
    <span className="brand-sized" style={{ width: size, height: size }}>
      <InlineSvg svg={markSvg} className="brand-svg" {...(label ? { label } : {})} />
    </span>
  );
}

/** The mark beside the wordmark, as used in the navigation bar. */
export function BrandLogo() {
  return (
    <span className="brand-logo d-inline-flex align-items-center gap-2">
      <BrandMark size={30} />
      <span className="brand-sized brand-wordmark">
        <InlineSvg svg={wordmarkSvg} className="brand-svg" />
      </span>
      <span className="visually-hidden">EmuCat</span>
    </span>
  );
}

export type MascotMood = 'idle' | 'sleeping' | 'puzzled';

const MOOD_LABELS: Record<MascotMood, string> = {
  idle: 'The EmuCat cat',
  sleeping: 'The EmuCat cat, asleep',
  puzzled: 'The EmuCat cat, looking puzzled',
};

/** The full mascot. Decorative unless `labelled`, because empty states already say what happened. */
export function Mascot({
  mood = 'idle',
  size = 96,
  labelled = false,
}: {
  mood?: MascotMood;
  size?: number;
  labelled?: boolean;
}) {
  return (
    <span
      className="brand-sized brand-mascot"
      data-mood={mood}
      style={{ width: size, height: size }}
    >
      <InlineSvg
        svg={mascotSvg}
        className="brand-svg"
        {...(labelled ? { label: MOOD_LABELS[mood] } : {})}
      />
    </span>
  );
}
