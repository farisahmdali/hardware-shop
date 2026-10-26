import type { Db } from '../db/connection';
import { getAllSettings } from '../services/settings';
import { getInvoice } from '../services/sales';
import { customerLedger, getCustomer } from '../services/customers';
import { getRental } from '../services/rentals';
import { getSupplier, supplierLedger } from '../services/suppliers';
import { AppError, ErrorCodes } from '@shared/errors';
import { amountInWords } from '@shared/billing';
import { formatMoney } from '@shared/money';
import { formatQty } from '@shared/qty';
import { formatDate, formatDateTime } from '@shared/time';
import { stateName } from '@shared/gstStates';
import type { DocumentKind, InvoiceDetail, Paper } from '@shared/contracts';

const esc = (s: string | number | null | undefined): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const m = (p: number) => esc(formatMoney(p, { symbol: false }));
const rate = (bp: number) => `${bp / 100}%`;

const BASE_CSS = `
  * { box-sizing: border-box; }
  body { margin: 0; font-family: 'Segoe UI', Arial, sans-serif; color: #111; font-size: 11px; line-height: 1.35; }
  table { border-collapse: collapse; width: 100%; }
  .r { text-align: right; } .c { text-align: center; } .b { font-weight: 600; } .muted { color: #555; }
  .nowrap { white-space: nowrap; }
`;

const A4_CSS = `${BASE_CSS}
  @page { size: A4; margin: 12mm 11mm; }
  h1 { font-size: 18px; margin: 0; } h2 { font-size: 13px; margin: 0; letter-spacing: 0.08em; }
  .head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #111; padding-bottom: 8px; }
  .box { border: 1px solid #999; padding: 6px 8px; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 0; margin-top: 8px; }
  .grid2 .box + .box { border-left: none; }
  .items { margin-top: 8px; }
  .items th { background: #f0f0f0; font-weight: 600; border: 1px solid #999; padding: 4px; font-size: 10px; }
  .items td { border-left: 1px solid #999; border-right: 1px solid #999; padding: 3px 4px; vertical-align: top; }
  .items tbody tr:last-child td { border-bottom: 1px solid #999; }
  .totals td { padding: 2px 4px; } .totals .grand td { border-top: 1.5px solid #111; font-size: 13px; font-weight: 700; padding-top: 4px; }
  .summary th, .summary td { border: 1px solid #999; padding: 3px 4px; font-size: 10px; }
  .summary th { background: #f0f0f0; }
  .foot { margin-top: 14px; display: flex; justify-content: space-between; align-items: flex-end; gap: 20px; }
  .sign { text-align: center; min-width: 180px; } .sign .line { border-top: 1px solid #111; margin-top: 40px; padding-top: 3px; }
  .stamp { border: 2px solid #b42318; color: #b42318; font-size: 18px; font-weight: 700; padding: 2px 10px; transform: rotate(-8deg); display: inline-block; }
`;

function thermalCss(widthMm: number): string {
  return `${BASE_CSS}
  @page { size: ${widthMm}mm auto; margin: 2mm; }
  body { width: ${widthMm - 4}mm; font-size: ${widthMm >= 80 ? 11 : 10}px; }
  .center { text-align: center; } hr { border: none; border-top: 1px dashed #000; margin: 4px 0; }
  td { padding: 1px 0; vertical-align: top; } .big { font-size: 14px; font-weight: 700; }
`;
}

function shopBlock(db: Db) {
  const s = getAllSettings(db);
  const address = [s.shop.addressLine1, s.shop.addressLine2, [s.shop.city, s.shop.pincode].filter(Boolean).join(' - ')].filter(Boolean);
  return { s, address };
}

function page(title: string, css: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><title>${esc(title)}</title><style>${css}</style></head><body>${body}</body></html>`;
}

// ---------- Invoice (A4) ----------

function invoiceA4(db: Db, inv: InvoiceDetail): string {
  const { s, address } = shopBlock(db);
  const isTax = inv.gstRegistered;
  const title = isTax ? 'TAX INVOICE' : 'BILL OF SUPPLY';
  const paid = inv.settlements.filter((x) => !x.reversed).reduce((a, x) => a + x.amount, 0);
  const lineRows = inv.lines
    .map(
      (l) => `<tr>
        <td class="c">${l.lineNo}</td>
        <td>${esc(l.name)}<div class="muted">${esc(l.sku)}</div></td>
        <td class="c">${esc(l.hsnCode)}</td>
        <td class="r nowrap">${esc(formatQty(l.qty))} ${esc(l.unitCode)}</td>
        <td class="r">${m(l.unitPrice)}${l.priceIncludesTax && isTax ? '<div class="muted">incl. GST</div>' : ''}</td>
        <td class="r">${l.discount ? m(l.discount) : ''}</td>
        <td class="r">${m(l.taxable)}</td>
        ${isTax ? `<td class="c">${rate(l.gstRateBp)}</td><td class="r">${m(l.cgst + l.sgst + l.igst)}</td>` : ''}
        <td class="r b">${m(l.lineTotal)}</td>
      </tr>`,
    )
    .join('');

  const byRate = new Map<number, { taxable: number; cgst: number; sgst: number; igst: number; hsn: Set<string> }>();
  for (const l of inv.lines) {
    const r = byRate.get(l.gstRateBp) ?? { taxable: 0, cgst: 0, sgst: 0, igst: 0, hsn: new Set<string>() };
    r.taxable += l.taxable;
    r.cgst += l.cgst;
    r.sgst += l.sgst;
    r.igst += l.igst;
    if (l.hsnCode) r.hsn.add(l.hsnCode);
    byRate.set(l.gstRateBp, r);
  }
  const summary =
    isTax && s.printing.showHsnSummary
      ? `<table class="summary" style="margin-top:8px"><thead><tr><th>HSN</th><th>GST rate</th><th class="r">Taxable value</th>
          ${inv.isInterstate ? '<th class="r">IGST</th>' : '<th class="r">CGST</th><th class="r">SGST</th>'}<th class="r">Total tax</th></tr></thead><tbody>
          ${[...byRate.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(
              ([bp, r]) => `<tr><td>${esc([...r.hsn].join(', '))}</td><td>${rate(bp)}</td><td class="r">${m(r.taxable)}</td>
                ${inv.isInterstate ? `<td class="r">${m(r.igst)}</td>` : `<td class="r">${m(r.cgst)}</td><td class="r">${m(r.sgst)}</td>`}
                <td class="r">${m(r.cgst + r.sgst + r.igst)}</td></tr>`,
            )
            .join('')}</tbody></table>`
      : '';

  const body = `
    <div class="head">
      <div>
        <h1>${esc(s.shop.name)}</h1>
        ${address.map((a) => `<div>${esc(a)}</div>`).join('')}
        <div>${[s.shop.phone && `Phone: ${esc(s.shop.phone)}`, s.shop.email && esc(s.shop.email)].filter(Boolean).join(' · ')}</div>
        ${s.shop.gstin ? `<div class="b">GSTIN: ${esc(s.shop.gstin)}</div>` : ''}
        <div>State: ${esc(stateName(inv.shopStateCode))} (${esc(inv.shopStateCode)})</div>
      </div>
      <div class="r">
        <h2>${title}</h2>
        <div style="margin-top:6px">Invoice no: <span class="b">${esc(inv.invoiceNo)}</span></div>
        <div>Date: ${esc(formatDateTime(inv.issuedAt))}</div>
        ${inv.outstanding > 0 ? `<div>Due date: ${esc(formatDate(inv.dueDate))}</div>` : ''}
        ${inv.status === 'CANCELLED' ? '<div style="margin-top:8px"><span class="stamp">CANCELLED</span></div>' : ''}
      </div>
    </div>
    <div class="grid2">
      <div class="box">
        <div class="muted">Bill to</div>
        <div class="b">${esc(inv.customerName)}</div>
        ${inv.customerAddress ? `<div>${esc(inv.customerAddress)}</div>` : ''}
        ${inv.customerPhone ? `<div>Phone: ${esc(inv.customerPhone)}</div>` : ''}
        ${inv.customerGstin ? `<div>GSTIN: ${esc(inv.customerGstin)}</div>` : ''}
      </div>
      <div class="box">
        <div class="muted">Place of supply</div>
        <div>${esc(stateName(inv.customerStateCode || inv.shopStateCode))} (${esc(inv.customerStateCode || inv.shopStateCode)})</div>
        ${isTax ? `<div class="muted" style="margin-top:4px">${inv.isInterstate ? 'Inter-state supply: IGST' : 'Intra-state supply: CGST + SGST'}</div>` : ''}
      </div>
    </div>
    <table class="items">
      <thead><tr><th>#</th><th>Item</th><th>HSN</th><th class="r">Qty</th><th class="r">Rate</th><th class="r">Discount</th>
        <th class="r">Taxable</th>${isTax ? '<th>GST</th><th class="r">Tax</th>' : ''}<th class="r">Amount</th></tr></thead>
      <tbody>${lineRows}</tbody>
    </table>
    <div style="display:flex; gap:16px; margin-top:8px">
      <div style="flex:1">
        <div><span class="muted">Amount in words:</span> <span class="b">${esc(amountInWords(inv.grandTotal))}</span></div>
        ${summary}
        ${inv.notes ? `<div style="margin-top:6px"><span class="muted">Notes:</span> ${esc(inv.notes)}</div>` : ''}
      </div>
      <table class="totals" style="width:260px">
        <tr><td>Gross amount</td><td class="r">${m(inv.grossTotal)}</td></tr>
        ${inv.discountTotal ? `<tr><td>Discount</td><td class="r">− ${m(inv.discountTotal)}</td></tr>` : ''}
        <tr><td>Taxable value</td><td class="r">${m(inv.taxableTotal)}</td></tr>
        ${inv.cgstTotal ? `<tr><td>CGST</td><td class="r">${m(inv.cgstTotal)}</td></tr><tr><td>SGST</td><td class="r">${m(inv.sgstTotal)}</td></tr>` : ''}
        ${inv.igstTotal ? `<tr><td>IGST</td><td class="r">${m(inv.igstTotal)}</td></tr>` : ''}
        ${inv.roundOff ? `<tr><td>Round-off</td><td class="r">${inv.roundOff > 0 ? '' : '− '}${m(Math.abs(inv.roundOff))}</td></tr>` : ''}
        <tr class="grand"><td>Total</td><td class="r">₹ ${m(inv.grandTotal)}</td></tr>
        ${inv.status !== 'CANCELLED' ? `<tr><td>Paid</td><td class="r">${m(paid)}</td></tr><tr><td class="b">Balance due</td><td class="r b">${m(inv.outstanding)}</td></tr>` : ''}
      </table>
    </div>
    <div class="foot">
      <div class="muted" style="max-width:60%">${esc(s.shop.invoiceFooter).replace(/\n/g, '<br>')}<div style="margin-top:6px">This is a computer-generated invoice.</div></div>
      <div class="sign">For ${esc(s.shop.name)}<div class="line">Authorised signatory</div></div>
    </div>`;
  return page(`${title} ${inv.invoiceNo}`, A4_CSS, body);
}

// ---------- Receipt (thermal) ----------

function invoiceThermal(db: Db, inv: InvoiceDetail, widthMm: number): string {
  const { s, address } = shopBlock(db);
  const paid = inv.settlements.filter((x) => !x.reversed);
  const rows = inv.lines
    .map(
      (l) => `<tr><td colspan="2">${esc(l.name)}</td></tr>
        <tr><td class="muted">${esc(formatQty(l.qty))} ${esc(l.unitCode)} × ${m(l.unitPrice)}${l.discount ? ` − ${m(l.discount)}` : ''}</td><td class="r">${m(l.lineTotal)}</td></tr>`,
    )
    .join('');
  const body = `
    <div class="center"><div class="big">${esc(s.shop.name)}</div>${address.map((a) => `<div>${esc(a)}</div>`).join('')}
      ${s.shop.phone ? `<div>Ph: ${esc(s.shop.phone)}</div>` : ''}${s.shop.gstin ? `<div>GSTIN: ${esc(s.shop.gstin)}</div>` : ''}</div>
    <hr><div class="center b">${inv.gstRegistered ? 'TAX INVOICE' : 'BILL OF SUPPLY'}${inv.status === 'CANCELLED' ? ' — CANCELLED' : ''}</div>
    <div>${esc(inv.invoiceNo)}</div><div>${esc(formatDateTime(inv.issuedAt))}</div>
    ${inv.customerName ? `<div>Customer: ${esc(inv.customerName)}</div>` : ''}
    <hr><table>${rows}</table><hr>
    <table>
      ${inv.discountTotal ? `<tr><td>Discount</td><td class="r">− ${m(inv.discountTotal)}</td></tr>` : ''}
      <tr><td>Taxable</td><td class="r">${m(inv.taxableTotal)}</td></tr>
      ${inv.cgstTotal ? `<tr><td>CGST</td><td class="r">${m(inv.cgstTotal)}</td></tr><tr><td>SGST</td><td class="r">${m(inv.sgstTotal)}</td></tr>` : ''}
      ${inv.igstTotal ? `<tr><td>IGST</td><td class="r">${m(inv.igstTotal)}</td></tr>` : ''}
      ${inv.roundOff ? `<tr><td>Round-off</td><td class="r">${m(inv.roundOff)}</td></tr>` : ''}
      <tr><td class="big">TOTAL</td><td class="r big">₹${m(inv.grandTotal)}</td></tr>
      ${paid.map((p) => `<tr><td>${esc(p.methodName ?? p.docNo)}</td><td class="r">${m(p.amount)}</td></tr>`).join('')}
      ${inv.outstanding > 0 && inv.status !== 'CANCELLED' ? `<tr><td class="b">Balance due</td><td class="r b">${m(inv.outstanding)}</td></tr>` : ''}
    </table>
    <hr><div class="center">${esc(s.printing.receiptFooter)}</div>`;
  return page(`Receipt ${inv.invoiceNo}`, thermalCss(widthMm), body);
}

// ---------- Credit note ----------

function creditNoteA4(db: Db, id: number): string {
  const cn = db
    .prepare(
      `SELECT cn.*, i.invoice_no, i.issued_at AS invoice_date, i.customer_name, i.customer_address, i.customer_gstin, i.customer_phone, i.is_interstate
       FROM credit_notes cn JOIN invoices i ON i.id = cn.invoice_id WHERE cn.id = ?`,
    )
    .get(id) as
    | { credit_note_no: string; issued_at: string; invoice_no: string; invoice_date: string; customer_name: string; customer_address: string; customer_gstin: string; customer_phone: string; reason: string; settlement: string; taxable_total: number; cgst_total: number; sgst_total: number; igst_total: number; total: number }
    | undefined;
  if (!cn) throw new AppError(ErrorCodes.NOT_FOUND, 'Credit note not found.');
  const lines = db
    .prepare(
      `SELECT l.name, l.sku, l.hsn_code, l.unit_code, l.gst_rate_bp, cl.qty, cl.taxable, cl.cgst, cl.sgst, cl.igst, cl.line_total, cl.restock
       FROM credit_note_lines cl JOIN invoice_lines l ON l.id = cl.invoice_line_id WHERE cl.credit_note_id = ? ORDER BY cl.id`,
    )
    .all(id) as { name: string; sku: string; hsn_code: string; unit_code: string; gst_rate_bp: number; qty: number; taxable: number; cgst: number; sgst: number; igst: number; line_total: number; restock: number }[];
  const { s, address } = shopBlock(db);
  const body = `
    <div class="head">
      <div><h1>${esc(s.shop.name)}</h1>${address.map((a) => `<div>${esc(a)}</div>`).join('')}${s.shop.gstin ? `<div class="b">GSTIN: ${esc(s.shop.gstin)}</div>` : ''}</div>
      <div class="r"><h2>CREDIT NOTE</h2><div style="margin-top:6px">No: <span class="b">${esc(cn.credit_note_no)}</span></div>
        <div>Date: ${esc(formatDateTime(cn.issued_at))}</div><div>Against invoice ${esc(cn.invoice_no)} of ${esc(formatDate(cn.invoice_date))}</div></div>
    </div>
    <div class="box" style="margin-top:8px"><div class="muted">Customer</div><div class="b">${esc(cn.customer_name)}</div>
      ${cn.customer_address ? `<div>${esc(cn.customer_address)}</div>` : ''}${cn.customer_gstin ? `<div>GSTIN: ${esc(cn.customer_gstin)}</div>` : ''}</div>
    <table class="items"><thead><tr><th>Item</th><th>HSN</th><th class="r">Qty returned</th><th class="r">Taxable</th><th>GST</th><th class="r">Tax</th><th class="r">Amount</th></tr></thead>
      <tbody>${lines
        .map(
          (l) => `<tr><td>${esc(l.name)}<div class="muted">${esc(l.sku)}${l.restock ? '' : ' · not restocked'}</div></td><td class="c">${esc(l.hsn_code)}</td>
            <td class="r">${esc(formatQty(l.qty))} ${esc(l.unit_code)}</td><td class="r">${m(l.taxable)}</td><td class="c">${rate(l.gst_rate_bp)}</td>
            <td class="r">${m(l.cgst + l.sgst + l.igst)}</td><td class="r b">${m(l.line_total)}</td></tr>`,
        )
        .join('')}</tbody></table>
    <div style="display:flex; gap:16px; margin-top:8px">
      <div style="flex:1"><div><span class="muted">Reason:</span> ${esc(cn.reason)}</div>
        <div><span class="muted">Settled as:</span> ${cn.settlement === 'REFUND' ? 'refund to customer' : 'credit to customer account'}</div>
        <div style="margin-top:4px"><span class="muted">Amount in words:</span> <span class="b">${esc(amountInWords(cn.total))}</span></div></div>
      <table class="totals" style="width:240px">
        <tr><td>Taxable value</td><td class="r">${m(cn.taxable_total)}</td></tr>
        ${cn.cgst_total ? `<tr><td>CGST</td><td class="r">${m(cn.cgst_total)}</td></tr><tr><td>SGST</td><td class="r">${m(cn.sgst_total)}</td></tr>` : ''}
        ${cn.igst_total ? `<tr><td>IGST</td><td class="r">${m(cn.igst_total)}</td></tr>` : ''}
        <tr class="grand"><td>Total credit</td><td class="r">₹ ${m(cn.total)}</td></tr>
      </table>
    </div>
    <div class="foot"><div class="muted">This is a computer-generated credit note.</div><div class="sign">For ${esc(s.shop.name)}<div class="line">Authorised signatory</div></div></div>`;
  return page(`Credit note ${cn.credit_note_no}`, A4_CSS, body);
}

// ---------- Customer statement ----------

function statementA4(db: Db, customerId: number, asOf: string, from?: string, to?: string): string {
  const c = getCustomer(db, customerId, asOf);
  const ledger = customerLedger(db, customerId, { from, to }, asOf);
  const { s, address } = shopBlock(db);
  const bal = (b: number) => (b === 0 ? '0.00' : b > 0 ? `${m(b)} Dr` : `${m(-b)} Cr`);
  const body = `
    <div class="head">
      <div><h1>${esc(s.shop.name)}</h1>${address.map((a) => `<div>${esc(a)}</div>`).join('')}${s.shop.phone ? `<div>Phone: ${esc(s.shop.phone)}</div>` : ''}</div>
      <div class="r"><h2>STATEMENT OF ACCOUNT</h2><div style="margin-top:6px">${esc(formatDate(ledger.from))} to ${esc(formatDate(ledger.to))}</div>
        <div>Printed ${esc(formatDate(asOf))}</div></div>
    </div>
    <div class="box" style="margin-top:8px"><div class="b">${esc(c.name)}</div>${c.businessName ? `<div>${esc(c.businessName)}</div>` : ''}
      ${c.address ? `<div>${esc(c.address)}</div>` : ''}${c.phone ? `<div>Phone: ${esc(c.phone)}</div>` : ''}${c.gstin ? `<div>GSTIN: ${esc(c.gstin)}</div>` : ''}
      <div class="muted">Customer code ${esc(c.code)}</div></div>
    <table class="items"><thead><tr><th>Date</th><th>Document</th><th>Details</th><th class="r">Debit</th><th class="r">Credit</th><th class="r">Balance</th></tr></thead>
      <tbody>
        <tr><td>${esc(formatDate(ledger.from))}</td><td></td><td class="b">Opening balance</td><td></td><td></td><td class="r b">${bal(ledger.openingBalance)}</td></tr>
        ${ledger.rows
          .map(
            (r) => `<tr><td class="nowrap">${esc(formatDate(r.businessDate))}</td><td class="nowrap">${esc(r.docNo)}</td><td>${esc(r.description)}</td>
              <td class="r">${r.debit ? m(r.debit) : ''}</td><td class="r">${r.credit ? m(r.credit) : ''}</td><td class="r">${bal(r.balance)}</td></tr>`,
          )
          .join('')}
      </tbody></table>
    <table class="totals" style="width:300px; margin-left:auto; margin-top:8px">
      <tr><td>Total debits</td><td class="r">${m(ledger.totalDebit)}</td></tr>
      <tr><td>Total credits</td><td class="r">${m(ledger.totalCredit)}</td></tr>
      <tr class="grand"><td>Closing balance</td><td class="r">${bal(ledger.closingBalance)}</td></tr>
    </table>
    <p class="muted">Dr = amount due from you. Cr = credit in your favour. Please contact us if anything here does not match your records.</p>`;
  return page(`Statement ${c.name}`, A4_CSS, body);
}

// ---------- Debit note (goods returned to a supplier) ----------

function debitNoteA4(db: Db, id: number): string {
  const dn = db
    .prepare(
      `SELECT d.*, p.purchase_no, p.supplier_invoice_no, p.supplier_invoice_date, p.supplier_name, p.supplier_gstin,
              p.shop_state_code, s.address AS supplier_address, s.phone AS supplier_phone
       FROM debit_notes d JOIN purchases p ON p.id = d.purchase_id JOIN suppliers s ON s.id = d.supplier_id WHERE d.id = ?`,
    )
    .get(id) as
    | {
        debit_note_no: string;
        issued_at: string;
        purchase_no: string;
        supplier_invoice_no: string;
        supplier_invoice_date: string;
        supplier_name: string;
        supplier_gstin: string;
        shop_state_code: string;
        supplier_address: string;
        supplier_phone: string;
        reason: string;
        settlement: string;
        taxable_total: number;
        cgst_total: number;
        sgst_total: number;
        igst_total: number;
        total: number;
      }
    | undefined;
  if (!dn) throw new AppError(ErrorCodes.NOT_FOUND, 'Debit note not found.');
  const lines = db
    .prepare(
      `SELECT l.name, l.sku, l.hsn_code, l.unit_code, l.gst_rate_bp, l.unit_cost, dl.qty, dl.taxable, dl.cgst, dl.sgst, dl.igst, dl.line_total
       FROM debit_note_lines dl JOIN purchase_lines l ON l.id = dl.purchase_line_id WHERE dl.debit_note_id = ? ORDER BY dl.id`,
    )
    .all(id) as { name: string; sku: string; hsn_code: string; unit_code: string; gst_rate_bp: number; unit_cost: number; qty: number; taxable: number; cgst: number; sgst: number; igst: number; line_total: number }[];
  const { s, address } = shopBlock(db);
  const body = `
    <div class="head">
      <div><h1>${esc(s.shop.name)}</h1>${address.map((a) => `<div>${esc(a)}</div>`).join('')}
        ${s.shop.phone ? `<div>Phone: ${esc(s.shop.phone)}</div>` : ''}${s.shop.gstin ? `<div class="b">GSTIN: ${esc(s.shop.gstin)}</div>` : ''}
        <div>State: ${esc(stateName(dn.shop_state_code))} (${esc(dn.shop_state_code)})</div></div>
      <div class="r"><h2>DEBIT NOTE</h2><div style="margin-top:6px">No: <span class="b">${esc(dn.debit_note_no)}</span></div>
        <div>Date: ${esc(formatDateTime(dn.issued_at))}</div>
        <div>Against your bill ${esc(dn.supplier_invoice_no || '(no number)')} of ${esc(formatDate(dn.supplier_invoice_date))}</div>
        <div class="muted">Our purchase ${esc(dn.purchase_no)}</div></div>
    </div>
    <div class="box" style="margin-top:8px"><div class="muted">To (supplier)</div><div class="b">${esc(dn.supplier_name)}</div>
      ${dn.supplier_address ? `<div>${esc(dn.supplier_address)}</div>` : ''}${dn.supplier_phone ? `<div>Phone: ${esc(dn.supplier_phone)}</div>` : ''}
      ${dn.supplier_gstin ? `<div>GSTIN: ${esc(dn.supplier_gstin)}</div>` : ''}</div>
    <table class="items"><thead><tr><th>Item returned</th><th>HSN</th><th class="r">Qty</th><th class="r">Rate</th><th class="r">Taxable</th><th>GST</th><th class="r">Tax</th><th class="r">Amount</th></tr></thead>
      <tbody>${lines
        .map(
          (l) => `<tr><td>${esc(l.name)}<div class="muted">${esc(l.sku)}</div></td><td class="c">${esc(l.hsn_code)}</td>
            <td class="r nowrap">${esc(formatQty(l.qty))} ${esc(l.unit_code)}</td><td class="r">${m(l.unit_cost)}</td><td class="r">${m(l.taxable)}</td>
            <td class="c">${rate(l.gst_rate_bp)}</td><td class="r">${m(l.cgst + l.sgst + l.igst)}</td><td class="r b">${m(l.line_total)}</td></tr>`,
        )
        .join('')}</tbody></table>
    <div style="display:flex; gap:16px; margin-top:8px">
      <div style="flex:1"><div><span class="muted">Reason for return:</span> ${esc(dn.reason)}</div>
        <div><span class="muted">To be settled by:</span> ${dn.settlement === 'REFUND' ? 'refund to us' : 'adjustment against our account'}</div>
        <div style="margin-top:4px"><span class="muted">Amount in words:</span> <span class="b">${esc(amountInWords(dn.total))}</span></div></div>
      <table class="totals" style="width:240px">
        <tr><td>Taxable value</td><td class="r">${m(dn.taxable_total)}</td></tr>
        ${dn.cgst_total ? `<tr><td>CGST</td><td class="r">${m(dn.cgst_total)}</td></tr><tr><td>SGST</td><td class="r">${m(dn.sgst_total)}</td></tr>` : ''}
        ${dn.igst_total ? `<tr><td>IGST</td><td class="r">${m(dn.igst_total)}</td></tr>` : ''}
        <tr class="grand"><td>Total</td><td class="r">₹ ${m(dn.total)}</td></tr>
      </table>
    </div>
    <div class="foot"><div class="sign">Received by (supplier)<div class="line">&nbsp;</div></div><div class="sign">For ${esc(s.shop.name)}<div class="line">Authorised signatory</div></div></div>`;
  return page(`Debit note ${dn.debit_note_no}`, A4_CSS, body);
}

// ---------- Supplier statement ----------

function supplierStatementA4(db: Db, supplierId: number, asOf: string, from?: string, to?: string): string {
  const sup = getSupplier(db, supplierId, asOf);
  const ledger = supplierLedger(db, supplierId, { from, to }, asOf);
  const { s, address } = shopBlock(db);
  const bal = (b: number) => (b === 0 ? '0.00' : b > 0 ? `${m(b)} Cr` : `${m(-b)} Dr`);
  const body = `
    <div class="head">
      <div><h1>${esc(s.shop.name)}</h1>${address.map((a) => `<div>${esc(a)}</div>`).join('')}${s.shop.phone ? `<div>Phone: ${esc(s.shop.phone)}</div>` : ''}</div>
      <div class="r"><h2>SUPPLIER ACCOUNT</h2><div style="margin-top:6px">${esc(formatDate(ledger.from))} to ${esc(formatDate(ledger.to))}</div>
        <div>Printed ${esc(formatDate(asOf))}</div></div>
    </div>
    <div class="box" style="margin-top:8px"><div class="b">${esc(sup.name)}</div>${sup.businessName ? `<div>${esc(sup.businessName)}</div>` : ''}
      ${sup.address ? `<div>${esc(sup.address)}</div>` : ''}${sup.phone ? `<div>Phone: ${esc(sup.phone)}</div>` : ''}${sup.gstin ? `<div>GSTIN: ${esc(sup.gstin)}</div>` : ''}
      <div class="muted">Supplier code ${esc(sup.code)}</div></div>
    <table class="items"><thead><tr><th>Date</th><th>Document</th><th>Details</th><th class="r">Debit</th><th class="r">Credit</th><th class="r">Balance</th></tr></thead>
      <tbody>
        <tr><td>${esc(formatDate(ledger.from))}</td><td></td><td class="b">Opening balance</td><td></td><td></td><td class="r b">${bal(ledger.openingBalance)}</td></tr>
        ${ledger.rows
          .map(
            (r) => `<tr><td class="nowrap">${esc(formatDate(r.businessDate))}</td><td class="nowrap">${esc(r.docNo)}</td><td>${esc(r.description)}</td>
              <td class="r">${r.debit ? m(r.debit) : ''}</td><td class="r">${r.credit ? m(r.credit) : ''}</td><td class="r">${bal(r.balance)}</td></tr>`,
          )
          .join('')}
      </tbody></table>
    <table class="totals" style="width:300px; margin-left:auto; margin-top:8px">
      <tr><td>Total debits</td><td class="r">${m(ledger.totalDebit)}</td></tr>
      <tr><td>Total credits</td><td class="r">${m(ledger.totalCredit)}</td></tr>
      <tr class="grand"><td>Closing balance</td><td class="r">${bal(ledger.closingBalance)}</td></tr>
    </table>
    <p class="muted">Cr = amount we owe you. Dr = advances or returns in our favour. Please tell us if anything here does not match your records.</p>`;
  return page(`Supplier account ${sup.name}`, A4_CSS, body);
}

// ---------- Rental agreement ----------

function rentalAgreementA4(db: Db, id: number): string {
  const r = getRental(db, id, new Date().toISOString());
  const { s, address } = shopBlock(db);
  const c = db.prepare('SELECT address, gstin FROM customers WHERE id = ?').get(r.customerId) as { address: string; gstin: string };
  const p = r.pricing;
  const rateText = (rates: { unit: string; unitMinutes: number; price: number; label?: string }[]) =>
    rates.map((x) => `${m(x.price)} / ${esc(x.label || x.unit.toLowerCase())}`).join(' · ');
  const lateRule =
    p.lateFeeMode === 'FIXED_PER_DAY'
      ? `₹${m(p.lateFeePerDay)} for each started day late`
      : p.lateFeeMode === 'MULTIPLIER'
        ? `the extra time at the rates above × ${p.lateMultiplierBp / 10_000}`
        : 'the extra time at the rates above';
  const body = `
    <div class="head">
      <div><h1>${esc(s.shop.name)}</h1>${address.map((a) => `<div>${esc(a)}</div>`).join('')}
        ${s.shop.phone ? `<div>Phone: ${esc(s.shop.phone)}</div>` : ''}${s.shop.gstin ? `<div class="b">GSTIN: ${esc(s.shop.gstin)}</div>` : ''}</div>
      <div class="r"><h2>RENTAL AGREEMENT</h2><div style="margin-top:6px">No: <span class="b">${esc(r.rentalNo)}</span></div>
        <div>Status: ${esc(r.status.replace(/_/g, ' ').toLowerCase())}</div>
        ${r.linkedInvoice ? `<div>Sold with invoice ${esc(r.linkedInvoice.invoiceNo)}</div>` : ''}</div>
    </div>
    <div class="grid2">
      <div class="box"><div class="muted">Customer</div><div class="b">${esc(r.customerName)}</div>
        ${r.customerPhone ? `<div>Phone: ${esc(r.customerPhone)}</div>` : ''}${c.address ? `<div>${esc(c.address)}</div>` : ''}${c.gstin ? `<div>GSTIN: ${esc(c.gstin)}</div>` : ''}</div>
      <div class="box"><div class="muted">Rental period</div>
        <div>From <span class="b">${esc(formatDateTime(r.startAt))}</span></div>
        <div>Return by <span class="b">${esc(formatDateTime(r.expectedReturnAt))}</span></div>
        ${r.originalExpectedReturnAt !== r.expectedReturnAt ? `<div class="muted">Originally due ${esc(formatDateTime(r.originalExpectedReturnAt))}</div>` : ''}
        <div class="muted" style="margin-top:4px">Grace ${p.graceMinutes} minutes · ${p.billing === 'AT_ISSUE' ? 'charged at issue' : 'charged on return'}</div></div>
    </div>
    <table class="items">
      <thead><tr><th>Unit</th><th>Item</th><th>Serial</th><th>Condition out</th><th>Rates</th><th class="r">Deposit</th></tr></thead>
      <tbody>${r.items
        .filter((i) => i.status !== 'CANCELLED')
        .map(
          (i) => `<tr><td class="b nowrap">${esc(i.assetTag)}</td><td>${esc(i.productName)}</td><td>${esc(i.serialNo)}</td>
            <td>${esc((i.conditionAtIssue ?? 'not yet issued').toLowerCase())}</td><td>${rateText(i.rates)}</td><td class="r">${m(i.depositAmount)}</td></tr>`,
        )
        .join('')}</tbody>
    </table>
    ${
      r.charges.length
        ? `<table class="items" style="margin-top:8px"><thead><tr><th>Charge</th><th>How it was worked out</th><th class="r">Amount</th><th>Bill</th></tr></thead><tbody>
          ${r.charges
            .map((ch) => `<tr><td>${esc(ch.description)}</td><td class="muted">${esc(ch.explanation)}</td><td class="r">${m(ch.amount)}</td><td class="nowrap">${esc(ch.invoiceNo ?? '')}</td></tr>`)
            .join('')}</tbody></table>`
        : ''
    }
    <div style="display:flex; gap:16px; margin-top:8px">
      <div style="flex:1">
        <div><span class="muted">Late return:</span> ${esc(lateRule)}, after the grace period.</div>
        <div style="margin-top:6px"><span class="muted">Terms:</span> ${esc(r.terms)}</div>
        ${r.notes ? `<div style="margin-top:6px"><span class="muted">Notes:</span> ${esc(r.notes)}</div>` : ''}
      </div>
      <table class="totals" style="width:260px">
        <tr><td>Deposit collected</td><td class="r">${m(r.deposit.collected)}</td></tr>
        ${r.deposit.applied ? `<tr><td>Deposit used for charges</td><td class="r">${m(r.deposit.applied)}</td></tr>` : ''}
        ${r.deposit.refunded ? `<tr><td>Deposit refunded</td><td class="r">${m(r.deposit.refunded)}</td></tr>` : ''}
        <tr class="grand"><td>Deposit held</td><td class="r">₹ ${m(r.deposit.held)}</td></tr>
        <tr><td>Charges unpaid</td><td class="r">${m(r.outstanding)}</td></tr>
      </table>
    </div>
    <div class="foot">
      <div class="sign">Customer's signature<div class="line">${esc(r.customerName)}</div></div>
      <div class="sign">For ${esc(s.shop.name)}<div class="line">Authorised signatory</div></div>
    </div>`;
  return page(`Rental agreement ${r.rentalNo}`, A4_CSS, body);
}

/** Renders a printable document to a self-contained HTML page (no scripts, no external resources). */
export function renderDocument(
  db: Db,
  kind: DocumentKind,
  id: number,
  paper: Paper,
  asOf: string,
  range: { from?: string; to?: string } = {},
): { html: string; title: string } {
  if (kind === 'INVOICE' || kind === 'RECEIPT') {
    const inv = getInvoice(db, id, false, asOf);
    const usePaper = kind === 'RECEIPT' && paper === 'A4' ? 'THERMAL_80' : paper;
    const html = usePaper === 'A4' ? invoiceA4(db, inv) : invoiceThermal(db, inv, usePaper === 'THERMAL_58' ? 58 : 80);
    return { html, title: `${inv.invoiceNo.replace(/\//g, '-')}` };
  }
  if (kind === 'RENTAL_AGREEMENT') {
    const no = (db.prepare('SELECT rental_no FROM rental_agreements WHERE id = ?').get(id) as { rental_no: string } | undefined)?.rental_no;
    if (!no) throw new AppError(ErrorCodes.NOT_FOUND, 'Rental not found.');
    return { html: rentalAgreementA4(db, id), title: no.replace(/\//g, '-') };
  }
  if (kind === 'CREDIT_NOTE') {
    const html = creditNoteA4(db, id);
    const no = (db.prepare('SELECT credit_note_no FROM credit_notes WHERE id = ?').get(id) as { credit_note_no: string }).credit_note_no;
    return { html, title: no.replace(/\//g, '-') };
  }
  if (kind === 'DEBIT_NOTE') {
    const html = debitNoteA4(db, id);
    const no = (db.prepare('SELECT debit_note_no FROM debit_notes WHERE id = ?').get(id) as { debit_note_no: string }).debit_note_no;
    return { html, title: no.replace(/\//g, '-') };
  }
  if (kind === 'SUPPLIER_STATEMENT') {
    const html = supplierStatementA4(db, id, asOf, range.from, range.to);
    const code = (db.prepare('SELECT code FROM suppliers WHERE id = ?').get(id) as { code: string }).code;
    return { html, title: `supplier-account-${code}` };
  }
  const html = statementA4(db, id, asOf, range.from, range.to);
  const code = (db.prepare('SELECT code FROM customers WHERE id = ?').get(id) as { code: string }).code;
  return { html, title: `statement-${code}` };
}
