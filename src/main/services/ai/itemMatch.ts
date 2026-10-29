/**
 * Matching an item as a supplier prints it ("SS HINGE 4\" HVY") to the shop's own product
 * ("Stainless steel butt hinge 100 mm"). Runs entirely on this computer. Names are normalised
 * (shop abbreviations expanded, sizes read and converted to one unit), then compared. A size that
 * differs rules a product out, so a ½" pipe is never offered for a 1" pipe.
 */

/** Abbreviations common on Indian hardware bills, expanded before comparing. */
const ABBREVIATIONS: Record<string, string> = {
  ss: 'stainless steel',
  ms: 'mild steel',
  gi: 'galvanised iron',
  ci: 'cast iron',
  cp: 'chrome plated',
  hss: 'high speed steel',
  hd: 'heavy duty',
  hvy: 'heavy',
  galvanized: 'galvanised',
  galv: 'galvanised',
  aluminum: 'aluminium',
  alu: 'aluminium',
  alum: 'aluminium',
  blk: 'black',
  wht: 'white',
  dia: 'diameter',
  sq: 'square',
  rd: 'round',
  hex: 'hexagonal',
  csk: 'countersunk',
  adj: 'adjustable',
  comb: 'combination',
  philips: 'phillips',
  scrw: 'screw',
  scr: 'screw',
  elec: 'electric',
  wd: 'wood',
  mtr: 'metre',
  mtrs: 'metre',
  meter: 'metre',
};

/** Words that say nothing about which product it is. */
const STOP_WORDS = new Set(['and', 'of', 'the', 'for', 'with', 'no', 'nos', 'pc', 'pcs', 'piece', 'pieces', 'qty', 'size', 'item', 'x', 'type']);

const FRACTIONS: Record<string, string> = { '½': ' 1/2', '¼': ' 1/4', '¾': ' 3/4', '⅛': ' 1/8', '⅜': ' 3/8', '⅝': ' 5/8', '⅞': ' 7/8' };

export type SizeKind = 'length' | 'mass' | 'volume' | 'power' | 'voltage' | 'current' | 'area';
export interface Size {
  kind: SizeKind;
  /** In mm, g, ml, W, V, A or mm². */
  value: number;
}

/** Each unit as written, its kind and its factor to the kind's base unit. */
const UNITS: [RegExp, SizeKind, number][] = [
  [/^(mm|millimet(er|re)s?)$/, 'length', 1],
  [/^(cm|centimet(er|re)s?)$/, 'length', 10],
  [/^(m|mtrs?|met(er|re)s?)$/, 'length', 1000],
  [/^(inch(es)?|in|"|''|”)$/, 'length', 25.4],
  [/^(ft|feet|foot|')$/, 'length', 304.8],
  [/^(kgs?|kilos?|kilograms?)$/, 'mass', 1000],
  [/^(g|gms?|grams?|gm)$/, 'mass', 1],
  [/^(ltrs?|lit(er|re)s?|l)$/, 'volume', 1000],
  [/^(ml)$/, 'volume', 1],
  [/^(w|watts?)$/, 'power', 1],
  [/^(kw)$/, 'power', 1000],
  [/^(hp)$/, 'power', 746],
  [/^(v|volts?)$/, 'voltage', 1],
  [/^(a|amps?)$/, 'current', 1],
  [/^(sq\s*mm|sqmm)$/, 'area', 1],
];

const NUMBER = String.raw`\d+\s*-\s*\d+\/\d+|\d+\s+\d+\/\d+|\d+\/\d+|\d+(?:\.\d+)?`;
const UNIT_WORD = String.raw`sq\s*mm|sqmm|millimet(?:er|re)s?|centimet(?:er|re)s?|met(?:er|re)s?|mtrs?|mm|cm|inch(?:es)?|in(?!\s*\d)|ft|feet|foot|kilograms?|kilos?|kgs?|kw|hp|grams?|gms?|gm|g|lit(?:er|re)s?|ltrs?|l|ml|watts?|w|volts?|v|amps?|a|m|"|''|”|'`;
const SIZE_RE = new RegExp(String.raw`(${NUMBER})((?:\s*[x×*]\s*(?:${NUMBER}))*)\s*(${UNIT_WORD})(?![a-z])`, 'gi');

function parseNumber(text: string): number {
  const t = text.trim();
  const mixed = /^(\d+)\s*[-\s]\s*(\d+)\/(\d+)$/.exec(t);
  if (mixed) return Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3]);
  const frac = /^(\d+)\/(\d+)$/.exec(t);
  if (frac) return Number(frac[1]) / Number(frac[2]);
  return Number(t);
}

export interface ItemFeatures {
  /** Meaningful words, abbreviations expanded. */
  words: string[];
  sizes: Size[];
  /** Numbers that are not part of a size (model numbers, gauges, counts). */
  numbers: string[];
}

export function analyseItem(text: string): ItemFeatures {
  let t = text.toLowerCase();
  for (const [f, r] of Object.entries(FRACTIONS)) t = t.split(f).join(r);
  t = t.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");

  const sizes: Size[] = [];
  t = t.replace(SIZE_RE, (_m, first: string, rest: string, unit: string) => {
    const spec = UNITS.find(([re]) => re.test(unit.replace(/\s+/g, ' ').trim()));
    if (!spec) return ' ';
    const values = [first, ...(rest ? rest.split(/[x×*]/).filter((s) => s.trim()) : [])].map(parseNumber);
    for (const v of values) if (Number.isFinite(v) && v > 0) sizes.push({ kind: spec[1], value: Math.round(v * spec[2] * 1000) / 1000 });
    return ' ';
  });

  // "4x12" without a unit: two numbers.
  t = t.replace(/(\d)\s*[x×*]\s*(?=\d)/g, '$1 ');
  const numbers: string[] = [];
  const words: string[] = [];
  for (const raw of t.split(/[^\p{L}\p{N}./]+/u)) {
    for (const part of raw.split('/')) {
      const w = part.replace(/^\.+|\.+$/g, '');
      if (!w) continue;
      if (/^\d+(\.\d+)?$/.test(w)) {
        numbers.push(String(Number(w)));
        continue;
      }
      const expanded = ABBREVIATIONS[w] ?? w;
      for (const e of expanded.split(' ')) if (e.length > 1 && !STOP_WORDS.has(e)) words.push(e);
    }
  }
  return { words: [...new Set(words)], sizes, numbers: [...new Set(numbers)] };
}

/** The text a remembered name is looked up by: the same however the bill spaces or abbreviates it. */
export function itemKey(text: string): string {
  const f = analyseItem(text);
  const sizes = f.sizes.map((s) => `${s.kind[0]}${s.value}`);
  return [...[...f.words].sort(), ...[...f.numbers].sort(), ...sizes.sort()].join(' ').slice(0, 300);
}

/** An FTS5 query finding products that share any word or number with the item, best first by rank. */
export function ftsQueryFor(f: ItemFeatures): string | null {
  const terms = [...f.words.filter((w) => w.length >= 2 && !/["*]/.test(w)), ...f.numbers.filter((n) => !n.includes('.'))].slice(0, 12);
  return terms.length ? terms.map((t) => `"${t}"*`).join(' OR ') : null;
}

const sameSize = (a: Size, b: Size) => a.kind === b.kind && Math.abs(a.value - b.value) <= Math.max(0.05 * Math.max(a.value, b.value), 0.3);

/** Sizes of one kind on both sides that do not agree. */
function sizesConflict(a: Size[], b: Size[]): boolean {
  const kinds = new Set(a.map((s) => s.kind));
  for (const kind of kinds) {
    const x = a.filter((s) => s.kind === kind);
    const y = b.filter((s) => s.kind === kind);
    if (!y.length) continue;
    if (!x.every((s) => y.some((o) => sameSize(s, o))) || !y.every((s) => x.some((o) => sameSize(s, o)))) return true;
  }
  return false;
}

export function formatSize(s: Size): string {
  const v = (n: number) => String(Math.round(n * 100) / 100);
  switch (s.kind) {
    case 'length':
      return s.value >= 1000 && s.value % 1000 === 0 ? `${v(s.value / 1000)} m` : `${v(s.value)} mm`;
    case 'mass':
      return s.value >= 1000 ? `${v(s.value / 1000)} kg` : `${v(s.value)} g`;
    case 'volume':
      return s.value >= 1000 ? `${v(s.value / 1000)} L` : `${v(s.value)} ml`;
    case 'power':
      return `${v(s.value)} W`;
    case 'voltage':
      return `${v(s.value)} V`;
    case 'current':
      return `${v(s.value)} A`;
    case 'area':
      return `${v(s.value)} sq mm`;
  }
}

const wordsMatch = (a: string, b: string) => a === b || (a.length >= 3 && b.length >= 3 && (a.startsWith(b) || b.startsWith(a)));

export interface MatchSide {
  features: ItemFeatures;
  hsnCode: string;
  unitId: number | null;
  /** Paise: the bill's rate, or the product's purchase price. */
  price: number | null;
}

export interface MatchScore {
  /** 0–100. */
  score: number;
  reasons: string[];
  /** A size or number on both that differs: never this product. */
  ruledOut: boolean;
}

export function scoreMatch(bill: MatchSide, product: MatchSide, formatPrice: (paise: number) => string): MatchScore {
  const a = bill.features;
  const b = product.features;
  if (sizesConflict(a.sizes, b.sizes)) return { score: 0, reasons: ['different size'], ruledOut: true };
  if (a.numbers.length && b.numbers.length && !a.numbers.some((n) => b.numbers.includes(n))) {
    return { score: 0, reasons: ['different number'], ruledOut: true };
  }

  const reasons: string[] = [];
  const common = a.words.filter((w) => b.words.some((o) => wordsMatch(w, o))).length;
  const dice = a.words.length + b.words.length ? (2 * common) / (a.words.length + b.words.length) : 0;
  let score = dice * 70;
  if (common) reasons.push(`${common} of ${a.words.length} words`);

  const shared = a.sizes.filter((s) => b.sizes.some((o) => sameSize(s, o)));
  if (shared.length) {
    score += 15;
    reasons.push(`size ${shared.map(formatSize).join(' × ')}`);
  }
  if (a.numbers.length && a.numbers.every((n) => b.numbers.includes(n))) score += 5;
  const hsnA = bill.hsnCode.replace(/\D/g, '');
  const hsnB = product.hsnCode.replace(/\D/g, '');
  if (hsnA.length >= 4 && hsnB.length >= 4 && (hsnA.startsWith(hsnB) || hsnB.startsWith(hsnA))) {
    score += 10;
    reasons.push('same HSN');
  }
  if (bill.unitId !== null && bill.unitId === product.unitId) score += 3;
  if (bill.price && product.price && Math.abs(bill.price - product.price) <= 0.2 * product.price) {
    score += 5;
    reasons.push(`last bought at ${formatPrice(product.price)}`);
  }
  return { score: Math.min(100, Math.round(score)), reasons, ruledOut: false };
}

/** Pre-select the best product only when it is a good match and clearly ahead of the next one. */
export function isClearBest(scores: number[]): boolean {
  const [top, second] = scores;
  return top !== undefined && top >= 75 && (second === undefined || second <= top - 15);
}

/** Bill units (NOS, MTR, KGS, …) to the shop's unit codes. */
const UNIT_SYNONYMS: Record<string, string> = {
  nos: 'PCS', no: 'PCS', nas: 'PCS', pc: 'PCS', pcs: 'PCS', piece: 'PCS', pieces: 'PCS', unit: 'PCS', units: 'PCS', ea: 'PCS', each: 'PCS',
  box: 'BOX', boxes: 'BOX', bx: 'BOX', ctn: 'BOX', carton: 'BOX',
  pkt: 'PKT', pkts: 'PKT', pack: 'PKT', packet: 'PKT', packets: 'PKT', pkg: 'PKT',
  set: 'SET', sets: 'SET',
  pair: 'PAIR', pairs: 'PAIR', pr: 'PAIR', prs: 'PAIR',
  roll: 'ROLL', rolls: 'ROLL', rl: 'ROLL',
  bag: 'BAG', bags: 'BAG',
  kg: 'KG', kgs: 'KG', kilo: 'KG', kilogram: 'KG',
  g: 'G', gm: 'G', gms: 'G', gram: 'G', grams: 'G',
  m: 'M', mtr: 'M', mtrs: 'M', meter: 'M', metre: 'M', meters: 'M', metres: 'M',
  ft: 'FT', feet: 'FT', foot: 'FT', rft: 'FT',
  l: 'L', ltr: 'L', ltrs: 'L', litre: 'L', liter: 'L', litres: 'L',
  sqft: 'SQFT', 'sq ft': 'SQFT', sft: 'SQFT',
};

export function mapUnit(text: string, units: { id: number; code: string }[]): number | null {
  const t = text.trim().toLowerCase().replace(/\.$/, '');
  if (!t) return null;
  const direct = units.find((u) => u.code.toLowerCase() === t);
  if (direct) return direct.id;
  const code = UNIT_SYNONYMS[t];
  return units.find((u) => u.code === code)?.id ?? null;
}
