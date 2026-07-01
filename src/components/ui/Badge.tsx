import type { ReactNode } from 'react';

type Tone = 'neutral' | 'green' | 'red' | 'amber' | 'blue';

const tones: Record<Tone, string> = {
  neutral: 'bg-black/10 text-pad-ink',
  green: 'bg-emerald-600/15 text-emerald-800',
  red: 'bg-pad-red/15 text-pad-red',
  amber: 'bg-amber-500/20 text-amber-800',
  blue: 'bg-sky-600/15 text-sky-800',
};

export function Badge({
  children,
  tone = 'neutral',
  pulse = false,
}: {
  children: ReactNode;
  tone?: Tone;
  pulse?: boolean;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold ${tones[tone]} ${
        pulse ? 'animate-pulseRing' : ''
      }`}
    >
      {children}
    </span>
  );
}
