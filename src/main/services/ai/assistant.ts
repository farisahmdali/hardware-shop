/**
 * The AI assistant: the OpenRouter key, checking the connection, and reading a supplier's bill
 * into a draft purchase. Nothing here saves a purchase: the draft is filled into the purchase form,
 * checked by a person and saved the usual way. Only the bill file is sent to OpenRouter.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import type { Db } from '../../db/connection';
import { transact, type Actor } from '../../db/tx';
import type { AiDeps, AppEnv } from '../env';
import { getAllSettings } from '../settings';
import { getProduct } from '../products';
import { OpenRouterClient, type ModelInfo } from './openrouter';
import { BILL_JSON_SCHEMA, BILL_PROMPT, extractJson, readBillAnswer, UnreadableAnswer, type ReadBill } from './billRead';
import { analyseItem, ftsQueryFor, isClearBest, itemKey, mapUnit, scoreMatch } from './itemMatch';
import { AppError, ErrorCodes } from '@shared/errors';
import { formatMoney } from '@shared/money';
import { businessDateOf } from '@shared/time';
import type { AiStatus, AiTestResult, ScanCandidate, ScanDraft, ScanLine, ScanSupplier } from '@shared/contracts';

export const MAX_BILL_FILE_BYTES = 10 * 1024 * 1024;
const SCAN_TIMEOUT_MS = 150_000;
export const BILL_FILE_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
};

// ---------- The API key ----------

/** The key is kept encrypted in the data folder, outside the database: never in backups or the history. */
const keyFile = (env: AppEnv) => join(env.paths.dataDir, 'ai', 'openrouter.key');

function deps(env: AppEnv): AiDeps {
  if (!env.ai) throw new AppError(ErrorCodes.BUSINESS_RULE, 'The AI assistant is not available in this copy of the application.');
  return env.ai;
}

export async function readApiKey(env: AppEnv): Promise<string | null> {
  if (!env.ai) return null;
  let data: Buffer;
  try {
    data = await readFile(keyFile(env));
  } catch {
    return null;
  }
  try {
    return env.ai.cipher.decrypt(data);
  } catch (e) {
    // Saved by another Windows user, or on another computer (copied data folder).
    env.logger.warn('The saved OpenRouter key could not be decrypted', (e as Error).message);
    return null;
  }
}

export async function setApiKey(env: AppEnv, actor: Actor, key: string): Promise<void> {
  const { cipher } = deps(env);
  if (!cipher.available()) {
    throw new AppError(ErrorCodes.BUSINESS_RULE, 'Windows cannot keep the key encrypted for this user, so it was not saved.');
  }
  const replaced = (await readApiKey(env)) !== null;
  const file = keyFile(env);
  await mkdir(join(env.paths.dataDir, 'ai'), { recursive: true });
  await writeFile(`${file}.tmp`, cipher.encrypt(key));
  await rename(`${file}.tmp`, file);
  transact(env, actor, (tx) =>
    tx.audit({
      module: 'settings',
      entityType: 'ai_key',
      entityId: 'openrouter',
      action: replaced ? 'AI_KEY_REPLACED' : 'AI_KEY_SET',
      // Never the key itself.
      after: { apiKey: 'Saved, encrypted on this computer' },
    }),
  );
}

export async function clearApiKey(env: AppEnv, actor: Actor): Promise<void> {
  const had = (await readApiKey(env)) !== null;
  await rm(keyFile(env), { force: true });
  if (!had) return;
  transact(env, actor, (tx) =>
    tx.audit({ module: 'settings', entityType: 'ai_key', entityId: 'openrouter', action: 'AI_KEY_REMOVED', before: { apiKey: 'Saved' } }),
  );
}

// ---------- Status ----------

/** Bills read in the shop's current calendar month, including failed attempts (OpenRouter may charge for them). */
export function scansThisMonth(env: AppEnv): number {
  const now = env.clock.now();
  const month = businessDateOf(now, env.timeZone).slice(0, 7);
  const since = new Date(Date.parse(`${month}-01T00:00:00Z`) - 86_400_000).toISOString();
  const rows = env.db
    .prepare("SELECT occurred_at FROM audit_log WHERE entity_type = 'bill_scan' AND occurred_at >= ?")
    .all(since) as { occurred_at: string }[];
  return rows.filter((r) => businessDateOf(r.occurred_at, env.timeZone).startsWith(month)).length;
}

export async function aiStatus(env: AppEnv, showKeyEnding: boolean): Promise<AiStatus> {
  const s = getAllSettings(env.db).ai;
  const key = await readApiKey(env);
  return {
    enabled: s.enabled,
    model: s.model,
    hasKey: key !== null,
    keyEnding: key && showKeyEnding ? key.slice(-4) : null,
    canStoreKey: !!env.ai && env.ai.cipher.available(),
    ready: !!env.ai && s.enabled && !!s.model && key !== null,
    monthlyScanLimit: s.monthlyScanLimit,
    scansThisMonth: scansThisMonth(env),
  };
}

async function client(env: AppEnv): Promise<OpenRouterClient> {
  const d = deps(env);
  const key = await readApiKey(env);
  if (!key) throw new AppError(ErrorCodes.BUSINESS_RULE, 'Save your OpenRouter API key in Backup & Settings → AI assistant first.');
  return new OpenRouterClient(d.fetch, key, d.baseUrl);
}

// The models list is large and rarely changes; it is looked up once an hour per model.
const modelCaches = new WeakMap<AiDeps, Map<string, { info: ModelInfo | null; at: number }>>();

async function modelInfo(env: AppEnv, api: OpenRouterClient, id: string, fresh = false): Promise<ModelInfo | null> {
  const d = deps(env);
  if (!modelCaches.has(d)) modelCaches.set(d, new Map());
  const cache = modelCaches.get(d)!;
  const cached = cache.get(id);
  if (!fresh && cached && Date.now() - cached.at < 3_600_000) return cached.info;
  const info = await api.model(id);
  cache.set(id, { info, at: Date.now() });
  return info;
}

export async function testConnection(env: AppEnv, model?: string): Promise<AiTestResult> {
  const id = (model ?? getAllSettings(env.db).ai.model).trim();
  if (!id) throw new AppError(ErrorCodes.VALIDATION, 'Enter the model to use, e.g. google/gemini-2.5-flash.');
  const api = await client(env);
  const { creditLeft } = await api.keyInfo();
  const info = await modelInfo(env, api, id, true);
  if (!info) throw new AppError(ErrorCodes.VALIDATION, `OpenRouter has no model called "${id}". Copy the model id from openrouter.ai/models.`);
  return {
    model: info.id,
    modelName: info.name,
    readsImages: info.inputModalities.includes('image'),
    readsPdf: info.inputModalities.includes('file'),
    structuredOutput: info.supportedParameters.includes('structured_outputs') || info.supportedParameters.includes('response_format'),
    creditLeft,
  };
}

// ---------- Reading a bill ----------

/** Refuses before a file is even chosen when scanning cannot work. */
export async function assertCanScan(env: AppEnv): Promise<void> {
  const s = getAllSettings(env.db).ai;
  if (!env.ai || !s.enabled) throw new AppError(ErrorCodes.BUSINESS_RULE, 'Scanning bills is switched off. An owner can switch it on in Backup & Settings → AI assistant.');
  if (!s.model) throw new AppError(ErrorCodes.BUSINESS_RULE, 'Choose the AI model in Backup & Settings → AI assistant first.');
  if ((await readApiKey(env)) === null) throw new AppError(ErrorCodes.BUSINESS_RULE, 'Save your OpenRouter API key in Backup & Settings → AI assistant first.');
  const used = scansThisMonth(env);
  if (used >= s.monthlyScanLimit) {
    throw new AppError(
      ErrorCodes.BUSINESS_RULE,
      `This month's limit of ${s.monthlyScanLimit} bill scans has been reached. An owner can raise it in Backup & Settings → AI assistant.`,
    );
  }
}

interface BillFile {
  name: string;
  mime: string;
  data: Buffer;
  size: number;
}

async function loadBillFile(env: AppEnv, path: string): Promise<BillFile> {
  const mime = BILL_FILE_TYPES[extname(path).toLowerCase()];
  if (!mime) throw new AppError(ErrorCodes.VALIDATION, 'Choose a photo (JPG, PNG or WEBP) or a PDF of the bill.');
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) throw new AppError(ErrorCodes.NOT_FOUND, 'The bill file could not be opened.');
  if (info.size > MAX_BILL_FILE_BYTES) throw new AppError(ErrorCodes.VALIDATION, 'The bill file is larger than 10 MB. Use a smaller photo or PDF.');
  if (info.size === 0) throw new AppError(ErrorCodes.VALIDATION, 'The bill file is empty.');
  let data: Buffer = await readFile(path);
  let type = mime;
  if (mime.startsWith('image/') && env.ai?.shrinkImage) {
    const smaller = env.ai.shrinkImage(data);
    if (smaller && smaller.data.length < data.length) {
      data = smaller.data;
      type = smaller.mime;
    }
  }
  return { name: basename(path), mime: type, data, size: info.size };
}

function recordScan(env: AppEnv, actor: Actor, scanId: string, action: 'AI_SCAN' | 'AI_SCAN_FAILED', after: Record<string, unknown>, reason?: string): void {
  transact(env, actor, (tx) =>
    tx.audit({ module: 'purchases', entityType: 'bill_scan', entityId: scanId, action, after, reason: reason ?? null }),
  );
}

/**
 * Sends the bill to the chosen model, checks its answer and matches it with the shop's suppliers
 * and products. Every attempt that reached OpenRouter is recorded in the history (file name, model,
 * how long it took and what it cost — never the key or the bill itself).
 */
export async function scanBill(env: AppEnv, actor: Actor, path: string, opts: { canSeeCost: boolean }): Promise<ScanDraft> {
  await assertCanScan(env);
  const settings = getAllSettings(env.db);
  const model = settings.ai.model;
  const file = await loadBillFile(env, path);
  const api = await client(env);
  const info = await modelInfo(env, api, model);
  if (!info) throw new AppError(ErrorCodes.VALIDATION, `OpenRouter has no model called "${model}". Check the model in Backup & Settings → AI assistant.`);
  const isPdf = file.mime === 'application/pdf';
  if (!isPdf && !info.inputModalities.includes('image')) {
    throw new AppError(ErrorCodes.BUSINESS_RULE, `The model ${info.name} cannot read images. Choose a model that can (Backup & Settings → AI assistant).`);
  }

  const dataUrl = `data:${file.mime};base64,${file.data.toString('base64')}`;
  const part = isPdf ? { type: 'file', file: { filename: file.name, file_data: dataUrl } } : { type: 'image_url', image_url: { url: dataUrl } };
  const structured = info.supportedParameters.includes('structured_outputs') || info.supportedParameters.includes('response_format');
  const body: Record<string, unknown> = {
    model,
    temperature: 0,
    messages: [
      { role: 'system', content: BILL_PROMPT },
      { role: 'user', content: [{ type: 'text', text: structured ? 'Read this bill.' : `Read this bill. Answer with only a JSON object following this JSON schema:\n${JSON.stringify(BILL_JSON_SCHEMA)}` }, part] },
    ],
    usage: { include: true },
  };
  if (structured) body.response_format = { type: 'json_schema', json_schema: { name: 'supplier_bill', strict: true, schema: BILL_JSON_SCHEMA } };

  const scanId = randomUUID();
  const started = Date.now();
  const summary = { fileName: file.name, fileSizeKb: Math.ceil(file.size / 1024), model };
  const failed = (message: string) => recordScan(env, actor, scanId, 'AI_SCAN_FAILED', { ...summary, seconds: Math.round((Date.now() - started) / 1000) }, message);

  let read: ReadBill;
  let usage: { aiUsage: string; costUsd: number | null };
  try {
    const answer = await api.chat(body, SCAN_TIMEOUT_MS);
    usage = { aiUsage: `${answer.promptTokens ?? '?'} in, ${answer.completionTokens ?? '?'} out`, costUsd: answer.cost };
    try {
      read = readBillAnswer(extractJson(answer.content), { shopGstin: settings.shop.gstin, today: businessDateOf(env.clock.now(), env.timeZone) });
    } catch (e) {
      if (!(e instanceof UnreadableAnswer)) throw e;
      throw new AppError(
        ErrorCodes.BUSINESS_RULE,
        e.message === 'NOT_A_BILL'
          ? 'This does not look like a supplier\'s bill. Choose a photo or PDF of the bill.'
          : 'The AI model\'s answer could not be read. Try again, or choose a model that supports structured output.',
        { detail: e.message },
      );
    }
    if (!read.lines.length) throw new AppError(ErrorCodes.BUSINESS_RULE, 'No items could be read from the bill. Try a clearer photo.');
  } catch (e) {
    failed(e instanceof AppError ? e.message : 'Unexpected error');
    throw e;
  }

  const draft = matchBill(env.db, read, { canSeeCost: opts.canSeeCost });
  recordScan(env, actor, scanId, 'AI_SCAN', {
    ...summary,
    seconds: Math.round((Date.now() - started) / 1000),
    itemsRead: read.lines.length,
    itemsMatched: draft.lines.filter((l) => l.match).length,
    supplier: draft.supplier.match?.name ?? (read.supplier.name || null),
    supplierInvoiceNo: read.billNo || null,
    ...usage,
  });
  return {
    ...draft,
    scanId,
    fileName: file.name,
    model,
    preview: isPdf ? null : dataUrl,
  };
}

// ---------- Matching with the shop's records (offline) ----------

const companyWords = /\b(m\/s|messrs|pvt|private|ltd|limited|llp|the|co|company|and)\b|[^a-z0-9]+/g;
const companyKey = (name: string) => name.toLowerCase().replace(companyWords, '');

interface CandidateRecord {
  id: number;
  name: string;
  sku: string;
  hsn_code: string;
  unit_id: number;
  purchase_price: number;
}

export function matchBill(db: Db, read: ReadBill, opts: { canSeeCost: boolean }): Omit<ScanDraft, 'scanId' | 'fileName' | 'model' | 'preview'> {
  const warnings = [...read.warnings];

  // ---- Supplier: GSTIN, then name ----
  let supplier: ScanSupplier | null = null;
  let how: 'GSTIN' | 'NAME' | null = null;
  type SupplierRec = { id: number; name: string; business_name: string; gstin: string; state_code: string; is_active: number };
  const toSupplier = (r: SupplierRec): ScanSupplier => ({ id: r.id, name: r.name, gstin: r.gstin, stateCode: r.state_code });
  if (read.supplier.gstin) {
    const r = db.prepare('SELECT * FROM suppliers WHERE gstin = ? ORDER BY is_active DESC, id LIMIT 1').get(read.supplier.gstin) as SupplierRec | undefined;
    if (r?.is_active) [supplier, how] = [toSupplier(r), 'GSTIN'];
    else if (r) warnings.push(`The supplier ${r.name} is inactive. Reactivate them, or choose another supplier.`);
  }
  if (!supplier && read.supplier.name) {
    const key = companyKey(read.supplier.name);
    const all = db.prepare('SELECT * FROM suppliers WHERE is_active = 1').all() as SupplierRec[];
    const found = key ? all.filter((r) => companyKey(r.name) === key || (r.business_name && companyKey(r.business_name) === key)) : [];
    if (found.length === 1) {
      [supplier, how] = [toSupplier(found[0]!), 'NAME'];
      if (read.supplier.gstin && found[0]!.gstin && found[0]!.gstin !== read.supplier.gstin) {
        warnings.push(`The GSTIN on the bill (${read.supplier.gstin}) differs from ${found[0]!.name}'s GSTIN (${found[0]!.gstin}). Check the supplier.`);
      }
    }
  }
  if (!supplier) warnings.push(`The supplier ${read.supplier.name ? `"${read.supplier.name}" ` : ''}was not found among your suppliers. Choose or add them.`);
  if (supplier && read.billNo) {
    const dup = db
      .prepare(
        `SELECT p.purchase_no FROM purchases p LEFT JOIN purchase_cancellations c ON c.purchase_id = p.id
         WHERE p.supplier_id = ? AND p.supplier_invoice_no = ? COLLATE NOCASE AND c.id IS NULL`,
      )
      .get(supplier.id, read.billNo) as { purchase_no: string } | undefined;
    if (dup) warnings.push(`Bill ${read.billNo} from ${supplier.name} is already recorded as ${dup.purchase_no}.`);
  }

  // ---- Products: remembered names, product code, then the closest names ----
  const units = db.prepare('SELECT id, code FROM units').all() as { id: number; code: string }[];
  const unitCode = new Map(units.map((u) => [u.id, u.code]));
  const remembered = db.prepare(
    `SELECT n.product_id FROM supplier_item_names n JOIN products p ON p.id = n.product_id
     WHERE n.supplier_id = ? AND n.item_key = ? AND p.is_active = 1`,
  );
  const rememberedAny = db.prepare(
    `SELECT n.product_id FROM supplier_item_names n JOIN products p ON p.id = n.product_id
     WHERE n.item_key = ? AND p.is_active = 1 GROUP BY n.product_id ORDER BY SUM(n.uses) DESC LIMIT 2`,
  );
  const byCode = db.prepare('SELECT id FROM products WHERE sku = ? COLLATE NOCASE AND is_active = 1');
  const search = db.prepare(
    `SELECT p.id, p.name, p.sku, p.hsn_code, p.unit_id, p.purchase_price
     FROM products_fts f JOIN products p ON p.id = f.rowid
     WHERE products_fts MATCH ? AND p.is_active = 1 ORDER BY f.rank LIMIT 40`,
  );
  const products = new Map<number, ReturnType<typeof getProduct>>();
  const productRow = (id: number) => {
    if (!products.has(id)) products.set(id, getProduct(db, id, opts.canSeeCost));
    return products.get(id)!;
  };

  const lines: ScanLine[] = read.lines.map((l, index) => {
    const n = index + 1;
    const features = analyseItem(l.text);
    const key = itemKey(l.text);
    const unitId = mapUnit(l.unitText, units);

    let match: ScanLine['match'] = null;
    let rememberedId: number | undefined;
    if (key) {
      if (supplier) rememberedId = (remembered.get(supplier.id, key) as { product_id: number } | undefined)?.product_id;
      if (rememberedId === undefined) {
        const any = rememberedAny.all(key) as { product_id: number }[];
        if (any.length === 1) rememberedId = any[0]!.product_id;
      }
    }
    if (rememberedId !== undefined) match = { product: productRow(rememberedId), how: 'REMEMBERED' };
    const code = !match && /^[A-Za-z0-9._/-]{2,40}$/.test(l.text.trim()) ? (byCode.get(l.text.trim()) as { id: number } | undefined) : undefined;
    if (code) match = { product: productRow(code.id), how: 'CODE' };

    const query = ftsQueryFor(features);
    const hsnTerm = l.hsnCode.length >= 4 ? `"${l.hsnCode.slice(0, 4)}"*` : null;
    const fts = [query, hsnTerm].filter(Boolean).join(' OR ');
    let scored: (ScanCandidate & { id: number })[] = [];
    if (fts) {
      const records = search.all(fts) as CandidateRecord[];
      scored = records
        .map((r) => {
          const s = scoreMatch(
            { features, hsnCode: l.hsnCode, unitId, price: l.rate || null },
            { features: analyseItem(`${r.name} ${r.sku}`), hsnCode: r.hsn_code, unitId: r.unit_id, price: r.purchase_price || null },
            formatMoney,
          );
          const reasons = opts.canSeeCost ? s.reasons : s.reasons.filter((x) => !x.startsWith('last bought'));
          return { id: r.id, score: s.score, reasons, ruledOut: s.ruledOut };
        })
        .filter((s) => !s.ruledOut && s.score >= 30)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3)
        .map(({ id, score, reasons }) => ({ id, score, reasons, product: undefined as never }));
    }
    if (!match && isClearBest(scored.map((s) => s.score))) match = { product: productRow(scored[0]!.id), how: 'BEST' };
    const candidates: ScanCandidate[] = scored.map((s) => ({ product: productRow(s.id), score: s.score, reasons: s.reasons }));
    if (match && !candidates.some((c) => c.product.id === match!.product.id)) {
      candidates.unshift({ product: match.product, score: 100, reasons: [match.how === 'REMEMBERED' ? 'remembered from an earlier bill' : 'same product code'] });
    }

    if (match) {
      const p = match.product;
      if (unitId !== null && unitId !== productRow(p.id).unitId) {
        warnings.push(`Item ${n} (${l.text}): the bill counts in ${unitCode.get(unitId)}, ${p.name} is counted in ${p.unitCode}. Check the quantity.`);
      }
      if (!p.allowDecimal && l.qty % 1000 !== 0) warnings.push(`Item ${n} (${l.text}): ${p.name} is counted in whole ${p.unitCode}; check the quantity.`);
    }
    return {
      index,
      text: l.text,
      hsnCode: l.hsnCode,
      unitText: l.unitText,
      unitId,
      qty: l.qty,
      rate: l.rate,
      discountBp: l.discountBp,
      gstRateBp: l.gstRateBp,
      printedAmount: l.printedAmount,
      match,
      candidates,
    };
  });

  return {
    supplier: { match: supplier, how, ...read.supplier },
    supplierInvoiceNo: read.billNo,
    supplierInvoiceDate: read.billDate,
    pricesIncludeTax: read.pricesIncludeTax,
    lines,
    additionalCosts: read.additionalCosts,
    additionalCostsNote: read.additionalCostsNote,
    roundOff: read.roundOff,
    printedTotal: read.printedTotal,
    warnings,
  };
}
