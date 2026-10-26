import { useEffect, useRef, useState, type ReactElement } from 'react';
import { formatMoney } from '@shared/money';
import { formatDate } from '@shared/time';

interface Point {
  date: string;
  sales: number;
  rental: number;
}

const SERIES = [
  { key: 'sales' as const, label: 'Product sales', color: 'var(--series-1)' },
  { key: 'rental' as const, label: 'Rental bills', color: 'var(--series-2)' },
];

/** Compact rupee axis labels in Indian units: ₹500, ₹12K, ₹1.2L, ₹3.4Cr. */
function compact(paise: number): string {
  const r = Math.round(paise / 100);
  const a = Math.abs(r);
  const sign = r < 0 ? '−' : '';
  if (a >= 1_00_00_000) return `${sign}₹${+(a / 1_00_00_000).toFixed(1)}Cr`;
  if (a >= 1_00_000) return `${sign}₹${+(a / 1_00_000).toFixed(1)}L`;
  if (a >= 1000) return `${sign}₹${+(a / 1000).toFixed(a >= 10_000 ? 0 : 1)}K`;
  return `${sign}₹${a}`;
}

/** A tidy step for about four gridlines: 1, 2 or 5 × a power of ten. */
function niceStep(max: number): number {
  if (max <= 0) return 100_00;
  const raw = max / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw)!;
}

const HEIGHT = 200;
const PAD = { top: 12, right: 8, bottom: 26, left: 56 };

/**
 * Amount billed each day, product sales and rental bills stacked. Hover or use the arrow keys
 * for a day's figures; the same figures are in the sales and rental reports.
 */
export function DailyBillingChart({ data }: { data: Point[] }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [active, setActive] = useState<number | null>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(240, e!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const pos = (p: Point) => Math.max(0, p.sales) + Math.max(0, p.rental);
  const neg = (p: Point) => Math.min(0, p.sales) + Math.min(0, p.rental);
  const step = niceStep(Math.max(...data.map(pos), 0));
  const top = Math.max(step, Math.ceil(Math.max(...data.map(pos), 0) / step) * step);
  const bottom = Math.floor(Math.min(...data.map(neg), 0) / step) * step;
  const plotW = width - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const y = (v: number) => PAD.top + ((top - v) / (top - bottom)) * plotH;
  const band = plotW / Math.max(1, data.length);
  const barW = Math.max(2, Math.min(24, band * 0.62));
  const ticks: number[] = [];
  for (let v = bottom; v <= top; v += step) ticks.push(v);
  const labelEvery = Math.ceil(data.length / Math.max(2, Math.floor(plotW / 64)));
  const shown = active === null ? null : data[active];

  /** One stacked column: positive parts upward from the baseline, negative parts downward, 2px gap between parts. */
  const column = (p: Point, i: number) => {
    const x = PAD.left + i * band + (band - barW) / 2;
    const parts: ReactElement[] = [];
    let up = 0;
    let down = 0;
    const visible = SERIES.filter((s) => p[s.key] !== 0);
    const topmost = [...visible].reverse().find((s) => p[s.key] > 0)?.key;
    for (const s of visible) {
      const v = p[s.key];
      const from = v > 0 ? up : down;
      const to = from + v;
      if (v > 0) up = to;
      else down = to;
      const y1 = y(Math.max(from, to));
      const y2 = y(Math.min(from, to));
      const gap = from !== 0 ? 2 : 0;
      const h = Math.max(1, y2 - y1 - gap);
      const yTop = v > 0 ? y1 : y1 + gap;
      // Rounded data-end on the outermost positive part only; square at the baseline.
      const r = s.key === topmost && v > 0 ? Math.min(4, h, barW / 2) : 0;
      parts.push(
        <path
          key={s.key}
          fill={s.color}
          d={
            r > 0
              ? `M${x},${yTop + h} V${yTop + r} Q${x},${yTop} ${x + r},${yTop} H${x + barW - r} Q${x + barW},${yTop} ${x + barW},${yTop + r} V${yTop + h} Z`
              : `M${x},${yTop} H${x + barW} V${yTop + h} H${x} Z`
          }
        />,
      );
    }
    return parts;
  };

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-4 text-[13px] text-ink-2" aria-hidden>
        {SERIES.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1.5">
            <span className="inline-block size-2.5 rounded-[2px]" style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>
      <div
        ref={box}
        className="relative outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
        tabIndex={0}
        role="img"
        aria-label={`Amount billed each day, ${formatDate(data[0]?.date)} to ${formatDate(data[data.length - 1]?.date)}. Use the arrow keys to read each day.`}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight') setActive((a) => Math.min(data.length - 1, (a ?? -1) + 1));
          else if (e.key === 'ArrowLeft') setActive((a) => Math.max(0, (a ?? data.length) - 1));
          else if (e.key === 'Escape') setActive(null);
        }}
        onBlur={() => setActive(null)}
        onPointerLeave={() => setActive(null)}
      >
        <svg width={width} height={HEIGHT} className="block">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} stroke="var(--border)" strokeWidth={1} />
              <text x={PAD.left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="fill-[var(--text-3)] text-[11px] tabular-nums">
                {compact(t)}
              </text>
            </g>
          ))}
          {data.map((p, i) =>
            i % labelEvery === 0 ? (
              <text key={p.date} x={PAD.left + i * band + band / 2} y={HEIGHT - 8} textAnchor="middle" className="fill-[var(--text-3)] text-[11px]">
                {formatDate(p.date).slice(0, 6)}
              </text>
            ) : null,
          )}
          {active !== null && <rect x={PAD.left + active * band} y={PAD.top} width={band} height={plotH} fill="var(--surface-2)" />}
          {data.map((p, i) => (
            <g key={p.date}>{column(p, i)}</g>
          ))}
          <line x1={PAD.left} x2={width - PAD.right} y1={y(0)} y2={y(0)} stroke="var(--border-strong)" strokeWidth={1} />
          {data.map((p, i) => (
            <rect key={p.date} x={PAD.left + i * band} y={PAD.top} width={band} height={plotH} fill="transparent" onPointerMove={() => setActive(i)} />
          ))}
        </svg>
        {shown && (
          <div
            className="pointer-events-none absolute top-0 z-10 min-w-44 rounded-md border border-line bg-surface px-3 py-2 text-[13px] shadow-pop"
            style={{ left: Math.min(width - 190, Math.max(0, PAD.left + active! * band + band / 2 - 88)) }}
          >
            <p className="mb-1 font-medium text-ink">{formatDate(shown.date)}</p>
            {SERIES.map((s) => (
              <p key={s.key} className="flex items-center justify-between gap-4">
                <span className="inline-flex items-center gap-1.5 text-ink-3">
                  <span className="inline-block h-0.5 w-3 rounded" style={{ background: s.color }} />
                  {s.label}
                </span>
                <span className="tabular font-semibold text-ink">{formatMoney(shown[s.key])}</span>
              </p>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
