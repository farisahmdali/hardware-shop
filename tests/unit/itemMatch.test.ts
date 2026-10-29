import { describe, expect, it } from 'vitest';
import { analyseItem, ftsQueryFor, isClearBest, itemKey, mapUnit, scoreMatch, type MatchSide } from '@main/services/ai/itemMatch';
import { isAllowedAiUrl } from '@main/services/ai/openrouter';
import { formatMoney } from '@shared/money';

const side = (text: string, o: Partial<Omit<MatchSide, 'features'>> = {}): MatchSide => ({
  features: analyseItem(text),
  hsnCode: o.hsnCode ?? '',
  unitId: o.unitId ?? null,
  price: o.price ?? null,
});
const score = (bill: string, product: string, b: Partial<MatchSide> = {}, p: Partial<MatchSide> = {}) => scoreMatch(side(bill, b), side(product, p), formatMoney);

describe('reading item names', () => {
  it('expands shop abbreviations and drops words that say nothing', () => {
    expect(analyseItem('SS HINGE HVY - 12 NOS').words).toEqual(['stainless', 'steel', 'hinge', 'heavy']);
    expect(analyseItem('GI Wire').words).toEqual(['galvanised', 'iron', 'wire']);
    expect(analyseItem('CP Pillar Cock').words).toEqual(['chrome', 'plated', 'pillar', 'cock']);
  });

  it('reads sizes in any unit and converts them', () => {
    expect(analyseItem('Tower bolt 6"').sizes).toEqual([{ kind: 'length', value: 152.4 }]);
    expect(analyseItem('PVC pipe ½ inch').sizes).toEqual([{ kind: 'length', value: 12.7 }]);
    expect(analyseItem('PVC pipe 1-1/2 in').sizes).toEqual([{ kind: 'length', value: 38.1 }]);
    expect(analyseItem('Drill bit 6mm').sizes).toEqual([{ kind: 'length', value: 6 }]);
    expect(analyseItem('Wall plug 6 x 30 mm').sizes).toEqual([{ kind: 'length', value: 6 }, { kind: 'length', value: 30 }]);
    expect(analyseItem('Fevicol SH 1kg').sizes).toEqual([{ kind: 'mass', value: 1000 }]);
    expect(analyseItem('Fevicol SH 500 gm').sizes).toEqual([{ kind: 'mass', value: 500 }]);
    expect(analyseItem('Apex emulsion 20 Ltr').sizes).toEqual([{ kind: 'volume', value: 20000 }]);
    expect(analyseItem('LED bulb 9W').sizes).toEqual([{ kind: 'power', value: 9 }]);
    expect(analyseItem('Copper wire 1.5 sq mm').sizes).toEqual([{ kind: 'area', value: 1.5 }]);
  });

  it('keeps model numbers and gauges as numbers, and does not take "4 in 1" for inches', () => {
    expect(analyseItem('Bosch GSB 500 RE').numbers).toEqual(['500']);
    expect(analyseItem('Hinge 4x12').numbers).toEqual(['4', '12']);
    const fourInOne = analyseItem('Screwdriver 4 in 1');
    expect(fourInOne.sizes).toEqual([]);
    expect(fourInOne.numbers).toEqual(['4', '1']);
  });

  it('gives the same key however the bill spaces, orders or abbreviates the name', () => {
    expect(itemKey('SS Hinge 4"')).toBe(itemKey('stainless steel  HINGE 4 inch'));
    expect(itemKey('Hinge SS 4 in')).toBe(itemKey('SS HINGE 4"'));
    expect(itemKey('SS Hinge 4"')).not.toBe(itemKey('SS Hinge 5"'));
    expect(itemKey('---')).toBe('');
  });

  it('builds an FTS query of the words and numbers', () => {
    expect(ftsQueryFor(analyseItem('GSB 500 drill'))).toBe('"gsb"* OR "drill"* OR "500"*');
    expect(ftsQueryFor(analyseItem('-'))).toBeNull();
  });
});

describe('matching an item to a product', () => {
  it('matches the same product under another name, with reasons', () => {
    const s = score('SS BUTT HINGE 4" HVY', 'Stainless steel butt hinge 100 mm', { hsnCode: '8302', price: 8200 }, { hsnCode: '83021010', price: 8000 });
    expect(s.ruledOut).toBe(false);
    expect(s.score).toBeGreaterThanOrEqual(75);
    expect(s.reasons).toEqual(expect.arrayContaining(['same HSN', 'size 101.6 mm', 'last bought at ₹80.00']));
  });

  it('never offers a product of a different size or number', () => {
    expect(score('PVC pipe 1/2"', 'PVC pipe 1 inch').ruledOut).toBe(true);
    expect(score('HSS drill bit 6 mm', 'HSS drill bit 8 mm').ruledOut).toBe(true);
    expect(score('Fevicol 1 kg', 'Fevicol 500 g').ruledOut).toBe(true);
    expect(score('Bosch GSB 500', 'Bosch GSB 600').ruledOut).toBe(true);
    // A size on one side only is not a conflict.
    expect(score('PVC pipe', 'PVC pipe 1 inch').ruledOut).toBe(false);
  });

  it('scores unrelated products low', () => {
    expect(score('Claw hammer', 'Measuring tape 5 m').score).toBeLessThan(30);
  });

  it('pre-selects only a clear best match', () => {
    expect(isClearBest([90])).toBe(true);
    expect(isClearBest([90, 70])).toBe(true);
    expect(isClearBest([90, 80])).toBe(false);
    expect(isClearBest([70])).toBe(false);
    expect(isClearBest([])).toBe(false);
  });

  it('maps the units printed on bills to the shop units', () => {
    const units = [
      { id: 1, code: 'PCS' },
      { id: 2, code: 'BOX' },
      { id: 3, code: 'KG' },
      { id: 4, code: 'M' },
    ];
    expect(mapUnit('NOS', units)).toBe(1);
    expect(mapUnit('Pcs.', units)).toBe(1);
    expect(mapUnit('box', units)).toBe(2);
    expect(mapUnit('KGS', units)).toBe(3);
    expect(mapUnit('MTR', units)).toBe(4);
    expect(mapUnit('DOZ', units)).toBeNull();
    expect(mapUnit('', units)).toBeNull();
  });
});

describe('the AI network allowance', () => {
  it('allows only OpenRouter, and a test server only when given', () => {
    expect(isAllowedAiUrl('https://openrouter.ai/api/v1/chat/completions')).toBe(true);
    expect(isAllowedAiUrl('https://openrouter.ai/api/v1/models')).toBe(true);
    expect(isAllowedAiUrl('https://openrouter.ai/')).toBe(false);
    expect(isAllowedAiUrl('https://openrouter.ai.evil.com/api/v1/x')).toBe(false);
    expect(isAllowedAiUrl('https://openrouter.ai/api/v1evil/x')).toBe(false);
    expect(isAllowedAiUrl('http://openrouter.ai/api/v1/models')).toBe(false);
    expect(isAllowedAiUrl('https://example.com/')).toBe(false);
    expect(isAllowedAiUrl('http://127.0.0.1:5555/api/v1/models')).toBe(false);
    expect(isAllowedAiUrl('http://127.0.0.1:5555/api/v1/models', 'http://127.0.0.1:5555/api/v1')).toBe(true);
    expect(isAllowedAiUrl('http://127.0.0.1:5555/other', 'http://127.0.0.1:5555/api/v1')).toBe(false);
  });
});
