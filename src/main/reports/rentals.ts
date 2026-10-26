import type { ReportImpl } from './engine';
import { periodKeys, periodLabel, periodSql, rangeInstants } from './periods';
import { col, share } from './util';
import { describeDuration, minutesBetween } from '@shared/rentalPricing';
import type { AssetStatus } from '@shared/contracts';
import type { ReportRow } from '@shared/reports';

const ASSET_STATUS: Record<AssetStatus, string> = {
  AVAILABLE: 'Available',
  RESERVED: 'Reserved',
  RENTED: 'Out on rent',
  AWAITING_INSPECTION: 'Awaiting inspection',
  DAMAGED: 'Damaged',
  MAINTENANCE: 'Under maintenance',
  RETIRED: 'Retired',
};

const HELD_SQL = (alias: string) =>
  `COALESCE((SELECT SUM(CASE d.type WHEN 'COLLECT' THEN d.amount ELSE -d.amount END) FROM deposit_transactions d WHERE d.agreement_id = ${alias}.id), 0)`;

const active: ReportImpl = ({ db, params: p, nowIso, limit }) => {
  const rows = db
    .prepare(
      `SELECT a.id, a.rental_no, a.customer_name, a.customer_phone, a.start_at, a.expected_return_at,
              (SELECT COUNT(*) FROM rental_items i WHERE i.agreement_id = a.id AND i.status = 'OUT') AS units_out,
              ${HELD_SQL('a')} AS held,
              COALESCE((SELECT SUM(b.outstanding) FROM invoices i JOIN v_invoice_balances b ON b.invoice_id = i.id WHERE i.rental_agreement_id = a.id), 0) AS unpaid
       FROM rental_agreements a
       WHERE a.status IN ('ACTIVE', 'PARTIALLY_RETURNED') AND (? IS NULL OR a.customer_id = ?)
       ORDER BY a.expected_return_at LIMIT ?`,
    )
    .all(p.customerId ?? null, p.customerId ?? null, limit + 1) as {
    id: number;
    rental_no: string;
    customer_name: string;
    customer_phone: string;
    start_at: string;
    expected_return_at: string;
    units_out: number;
    held: number;
    unpaid: number;
  }[];
  return {
    columns: [
      col('rental', 'Rental', 'code'),
      col('customer', 'Customer', 'text'),
      col('phone', 'Phone', 'text'),
      col('units', 'Units out', 'int', true),
      col('start', 'Out since', 'datetime'),
      col('due', 'Due back', 'datetime'),
      col('late', 'Late by', 'text'),
      col('held', 'Deposit held', 'money', true),
      col('unpaid', 'Charges unpaid', 'money', true),
    ],
    rows: rows.map((r) => ({
      link: { to: 'rental' as const, id: r.id },
      cells: {
        rental: r.rental_no,
        customer: r.customer_name,
        phone: r.customer_phone,
        units: r.units_out,
        start: r.start_at,
        due: r.expected_return_at,
        late: r.expected_return_at < nowIso ? describeDuration(minutesBetween(r.expected_return_at, nowIso)) : '',
        held: r.held,
        unpaid: r.unpaid,
      },
    })),
    summary: [
      { label: 'Rentals out', value: rows.length, kind: 'int' },
      { label: 'Overdue', value: rows.filter((r) => r.expected_return_at < nowIso).length, kind: 'int' },
    ],
  };
};

interface OutItem {
  id: number;
  rental_no: string;
  customer_name: string;
  customer_phone: string;
  expected_return_at: string;
  asset_tag: string;
  product_name: string;
  rental_product_id: number;
}

const OUT_ITEMS = `SELECT a.id, a.rental_no, a.customer_name, a.customer_phone, a.expected_return_at, i.asset_tag, i.product_name, i.rental_product_id
  FROM rental_items i JOIN rental_agreements a ON a.id = i.agreement_id WHERE i.status = 'OUT'`;

const overdue: ReportImpl = ({ db, nowIso, limit }) => {
  const rows = db.prepare(`${OUT_ITEMS} AND a.expected_return_at < ? ORDER BY a.expected_return_at, i.asset_tag LIMIT ?`).all(nowIso, limit + 1) as OutItem[];
  return {
    columns: [
      col('rental', 'Rental', 'code'),
      col('customer', 'Customer', 'text'),
      col('phone', 'Phone', 'text'),
      col('unit', 'Unit', 'code'),
      col('item', 'Item', 'text'),
      col('due', 'Was due', 'datetime'),
      col('late', 'Late by', 'text'),
    ],
    rows: rows.map((r) => ({
      link: { to: 'rental' as const, id: r.id },
      cells: {
        rental: r.rental_no,
        customer: r.customer_name,
        phone: r.customer_phone,
        unit: r.asset_tag,
        item: r.product_name,
        due: r.expected_return_at,
        late: describeDuration(minutesBetween(r.expected_return_at, nowIso)),
      },
    })),
    notes: ['A unit stays overdue until it is returned; it is never marked returned automatically.'],
  };
};

const expectedReturns: ReportImpl = ({ db, params: p, nowIso, limit }) => {
  const { start, end } = rangeInstants(p.from, p.to);
  const rows = db
    .prepare(`${OUT_ITEMS} AND a.expected_return_at >= ? AND a.expected_return_at < ? ORDER BY a.expected_return_at, i.asset_tag LIMIT ?`)
    .all(start, end, limit + 1) as OutItem[];
  return {
    columns: [
      col('due', 'Due back', 'datetime'),
      col('rental', 'Rental', 'code'),
      col('customer', 'Customer', 'text'),
      col('phone', 'Phone', 'text'),
      col('unit', 'Unit', 'code'),
      col('item', 'Item', 'text'),
      col('state', 'State', 'text'),
    ],
    rows: rows.map((r) => ({
      link: { to: 'rental' as const, id: r.id },
      cells: {
        due: r.expected_return_at,
        rental: r.rental_no,
        customer: r.customer_name,
        phone: r.customer_phone,
        unit: r.asset_tag,
        item: r.product_name,
        state: r.expected_return_at < nowIso ? 'Overdue' : 'Due',
      },
    })),
  };
};

const INCOME_ACCOUNTS = { RENTAL_INCOME: 'rental', LATE_FEE_INCOME: 'late', DAMAGE_INCOME: 'damage' } as const;

const revenueByPeriod: ReportImpl = ({ db, params: p }) => {
  const g = p.groupBy;
  const ledger = db
    .prepare(
      `SELECT ${periodSql('l.business_date', g)} AS k, a.code, SUM(l.credit - l.debit) AS amount
       FROM ledger_entries l JOIN accounts a ON a.id = l.account_id
       WHERE a.code IN ('RENTAL_INCOME', 'LATE_FEE_INCOME', 'DAMAGE_INCOME') AND l.business_date BETWEEN ? AND ?
       GROUP BY k, a.code`,
    )
    .all(p.from, p.to) as { k: string; code: keyof typeof INCOME_ACCOUNTS; amount: number }[];
  const bills = new Map(
    (
      db
        .prepare(`SELECT ${periodSql('i.business_date', g)} AS k, COUNT(*) AS n FROM invoices i WHERE i.kind = 'RENTAL' AND i.business_date BETWEEN ? AND ? GROUP BY k`)
        .all(p.from, p.to) as { k: string; n: number }[]
    ).map((r) => [r.k, r.n]),
  );
  const by = new Map<string, { rental: number; late: number; damage: number }>();
  for (const r of ledger) {
    const e = by.get(r.k) ?? { rental: 0, late: 0, damage: 0 };
    e[INCOME_ACCOUNTS[r.code]] += r.amount;
    by.set(r.k, e);
  }
  const rows: ReportRow[] = periodKeys(p.from, p.to, g).map((key) => {
    const e = by.get(key) ?? { rental: 0, late: 0, damage: 0 };
    return { cells: { period: periodLabel(key, g), bills: bills.get(key) ?? 0, rental: e.rental, late: e.late, damage: e.damage, total: e.rental + e.late + e.damage } };
  });
  const sum = (k: string) => rows.reduce((a, r) => a + (r.cells[k] as number), 0);
  return {
    columns: [
      col('period', 'Period', 'text'),
      col('bills', 'Rental bills', 'int', true),
      col('rental', 'Rental charges', 'money', true),
      col('late', 'Late fees', 'money', true),
      col('damage', 'Damage charges', 'money', true),
      col('total', 'Rental income', 'money', true),
    ],
    rows,
    summary: [
      { label: 'Rental income', value: sum('total'), kind: 'money', hint: 'Excluding GST' },
      { label: 'Late fees', value: sum('late'), kind: 'money' },
      { label: 'Damage charges', value: sum('damage'), kind: 'money' },
    ],
    notes: [
      'From the accounts, excluding GST. Income is counted when it is billed, under the rental billing rule in force (at issue or on return).',
      'Credits given on rental bills reduce income on the day of the credit note. Security deposits are not income.',
    ],
  };
};

const CHARGE_KIND = { BASE: 'rental', EXTENSION: 'rental', OTHER: 'rental', LATE_FEE: 'late', DAMAGE: 'damage' } as const;

const revenueByItem: ReportImpl = ({ db, params: p }) => {
  const billed = db
    .prepare(
      `SELECT ri.rental_product_id AS pid, rc.type, SUM(l.taxable) AS amount, COUNT(DISTINCT rc.agreement_id) AS rentals
       FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id JOIN rental_charges rc ON rc.id = l.rental_charge_id
       LEFT JOIN rental_items ri ON ri.id = rc.item_id
       WHERE i.business_date BETWEEN ? AND ? GROUP BY pid, rc.type`,
    )
    .all(p.from, p.to) as { pid: number | null; type: keyof typeof CHARGE_KIND; amount: number; rentals: number }[];
  const credited = db
    .prepare(
      `SELECT ri.rental_product_id AS pid, rc.type, SUM(cl.taxable) AS amount
       FROM credit_note_lines cl JOIN credit_notes cn ON cn.id = cl.credit_note_id JOIN invoice_lines l ON l.id = cl.invoice_line_id
       JOIN rental_charges rc ON rc.id = l.rental_charge_id LEFT JOIN rental_items ri ON ri.id = rc.item_id
       WHERE cn.business_date BETWEEN ? AND ? GROUP BY pid, rc.type`,
    )
    .all(p.from, p.to) as { pid: number | null; type: keyof typeof CHARGE_KIND; amount: number }[];
  const items = new Map(
    (
      db
        .prepare(
          `SELECT rp.id, rp.code, rp.name, (SELECT COUNT(*) FROM rental_assets a WHERE a.rental_product_id = rp.id AND a.status != 'RETIRED') AS units
           FROM rental_products rp`,
        )
        .all() as { id: number; code: string; name: string; units: number }[]
    ).map((r) => [r.id, r]),
  );
  const by = new Map<number, { rental: number; late: number; damage: number; rentals: number }>();
  const add = (pid: number | null, type: keyof typeof CHARGE_KIND, amount: number, rentals = 0) => {
    const key = pid ?? 0;
    const e = by.get(key) ?? { rental: 0, late: 0, damage: 0, rentals: 0 };
    e[CHARGE_KIND[type]] += amount;
    e.rentals += rentals;
    by.set(key, e);
  };
  for (const r of billed) add(r.pid, r.type, r.amount, r.rentals);
  for (const r of credited) add(r.pid, r.type, -r.amount);
  const rows = [...by.entries()]
    .map(([pid, e]) => {
      const it = items.get(pid);
      return {
        link: it ? { to: 'rentalProduct' as const, id: pid } : undefined,
        cells: {
          code: it?.code ?? '',
          item: it?.name ?? 'Not tied to one item',
          units: it?.units ?? null,
          rentals: e.rentals,
          rental: e.rental,
          late: e.late,
          damage: e.damage,
          total: e.rental + e.late + e.damage,
        },
      };
    })
    .sort((a, b) => (b.cells.total as number) - (a.cells.total as number));
  return {
    columns: [
      col('code', 'Code', 'code'),
      col('item', 'Item', 'text'),
      col('units', 'Units', 'int'),
      col('rentals', 'Rentals billed', 'int'),
      col('rental', 'Rental charges', 'money', true),
      col('late', 'Late fees', 'money', true),
      col('damage', 'Damage charges', 'money', true),
      col('total', 'Rental income', 'money', true),
    ],
    rows,
    notes: ['Excluding GST, by the date of the rental bill. Credits on rental bills are deducted on the day of the credit note.'],
  };
};

const revenueByCustomer: ReportImpl = ({ db, params: p, limit }) => {
  const rows = db
    .prepare(
      `WITH b AS (SELECT i.customer_id AS cid, COUNT(*) AS n, SUM(i.grand_total) AS total FROM invoices i
                  WHERE i.kind = 'RENTAL' AND i.business_date BETWEEN ? AND ? GROUP BY i.customer_id),
            c AS (SELECT cn.customer_id AS cid, SUM(cn.total) AS total FROM credit_notes cn JOIN invoices i ON i.id = cn.invoice_id
                  WHERE i.kind = 'RENTAL' AND cn.business_date BETWEEN ? AND ? GROUP BY cn.customer_id),
            o AS (SELECT i.customer_id AS cid, SUM(v.outstanding) AS owed FROM invoices i JOIN v_invoice_balances v ON v.invoice_id = i.id
                  WHERE i.kind = 'RENTAL' AND v.outstanding > 0 GROUP BY i.customer_id),
            ids AS (SELECT cid FROM b UNION SELECT cid FROM c)
       SELECT cu.id, cu.name, cu.phone, COALESCE(b.n, 0) AS n, COALESCE(b.total, 0) AS total, COALESCE(c.total, 0) AS credited, COALESCE(o.owed, 0) AS owed
       FROM ids JOIN customers cu ON cu.id = ids.cid LEFT JOIN b ON b.cid = cu.id LEFT JOIN c ON c.cid = cu.id LEFT JOIN o ON o.cid = cu.id
       ORDER BY COALESCE(b.total, 0) - COALESCE(c.total, 0) DESC LIMIT ?`,
    )
    .all(p.from, p.to, p.from, p.to, limit + 1) as { id: number; name: string; phone: string; n: number; total: number; credited: number; owed: number }[];
  return {
    columns: [
      col('customer', 'Customer', 'text'),
      col('phone', 'Phone', 'text'),
      col('bills', 'Rental bills', 'int', true),
      col('billed', 'Billed', 'money', true),
      col('credited', 'Credited', 'money', true),
      col('net', 'Net billed', 'money', true),
      col('owed', 'Owes on rentals now', 'money', true),
    ],
    rows: rows.map((r) => ({
      link: { to: 'customer' as const, id: r.id },
      cells: { customer: r.name, phone: r.phone, bills: r.n, billed: r.total, credited: r.credited, net: r.total - r.credited, owed: r.owed },
    })),
    notes: ['Amounts include GST, as billed. Deposits are not included.'],
  };
};

const utilization: ReportImpl = ({ db, params: p, nowIso }) => {
  const { start, end: rangeEnd } = rangeInstants(p.from, p.to);
  const end = rangeEnd < nowIso ? rangeEnd : nowIso;
  const periodMinutes = Math.max(0, minutesBetween(start, end));
  const products = db
    .prepare(
      `SELECT rp.id, rp.code, rp.name, (SELECT COUNT(*) FROM rental_assets a WHERE a.rental_product_id = rp.id AND a.status != 'RETIRED') AS units
       FROM rental_products rp ORDER BY rp.name`,
    )
    .all() as { id: number; code: string; name: string; units: number }[];
  const items =
    periodMinutes > 0
      ? (db
          .prepare(
            `SELECT rental_product_id AS pid, issued_at, returned_at FROM rental_items
             WHERE issued_at IS NOT NULL AND issued_at < ? AND (returned_at IS NULL OR returned_at > ?)`,
          )
          .all(end, start) as { pid: number; issued_at: string; returned_at: string | null }[])
      : [];
  const used = new Map<number, { minutes: number; rentals: number }>();
  for (const it of items) {
    const from = it.issued_at > start ? it.issued_at : start;
    const to = it.returned_at && it.returned_at < end ? it.returned_at : end;
    const u = used.get(it.pid) ?? { minutes: 0, rentals: 0 };
    u.minutes += Math.max(0, minutesBetween(from, to));
    u.rentals += 1;
    used.set(it.pid, u);
  }
  const rows = products
    .filter((pr) => pr.units > 0 || used.has(pr.id))
    .map((pr) => {
      const u = used.get(pr.id) ?? { minutes: 0, rentals: 0 };
      return {
        link: { to: 'rentalProduct' as const, id: pr.id },
        cells: {
          code: pr.code,
          item: pr.name,
          units: pr.units,
          rentals: u.rentals,
          days: Math.round((u.minutes * 1000) / 1440),
          utilisation: share(u.minutes, pr.units * periodMinutes),
        },
      };
    });
  const totalUnits = products.reduce((a, pr) => a + pr.units, 0);
  const totalMinutes = [...used.values()].reduce((a, u) => a + u.minutes, 0);
  return {
    columns: [
      col('code', 'Code', 'code'),
      col('item', 'Item', 'text'),
      col('units', 'Units', 'int', true),
      col('rentals', 'Times rented', 'int', true),
      col('days', 'Unit-days on rent', 'qty', true),
      col('utilisation', 'Utilisation', 'percent'),
    ],
    rows,
    summary: [{ label: 'Overall utilisation', value: share(totalMinutes, totalUnits * periodMinutes) ?? 0, kind: 'percent', hint: 'Share of available unit time spent on rent' }],
    notes: [
      'Utilisation = time units were out on rent ÷ (units × length of the period). The period ends now if it reaches into the future.',
      'Units are counted as they are today (retired units are left out).',
    ],
  };
};

const availability: ReportImpl = ({ db }) => {
  const rows = db
    .prepare(
      `SELECT rp.id, rp.code, rp.name, rp.is_active, COUNT(a.id) AS total,
              COALESCE(SUM(a.status = 'AVAILABLE'), 0) AS available, COALESCE(SUM(a.status = 'RESERVED'), 0) AS reserved,
              COALESCE(SUM(a.status = 'RENTED'), 0) AS rented, COALESCE(SUM(a.status = 'AWAITING_INSPECTION'), 0) AS inspection,
              COALESCE(SUM(a.status = 'DAMAGED'), 0) AS damaged, COALESCE(SUM(a.status = 'MAINTENANCE'), 0) AS maintenance,
              COALESCE(SUM(a.status = 'RETIRED'), 0) AS retired
       FROM rental_products rp LEFT JOIN rental_assets a ON a.rental_product_id = rp.id
       GROUP BY rp.id ORDER BY rp.name`,
    )
    .all() as Record<string, number | string>[];
  return {
    columns: [
      col('code', 'Code', 'code'),
      col('item', 'Item', 'text'),
      col('total', 'Units', 'int', true),
      col('available', 'Available', 'int', true),
      col('reserved', 'Reserved', 'int', true),
      col('rented', 'Out on rent', 'int', true),
      col('inspection', 'Awaiting inspection', 'int', true),
      col('damaged', 'Damaged', 'int', true),
      col('maintenance', 'Maintenance', 'int', true),
      col('retired', 'Retired', 'int', true),
    ],
    rows: rows.map((r) => ({
      link: { to: 'rentalProduct' as const, id: r.id as number },
      cells: {
        code: r.code as string,
        item: `${r.name as string}${r.is_active ? '' : ' (inactive)'}`,
        total: r.total as number,
        available: r.available as number,
        reserved: r.reserved as number,
        rented: r.rented as number,
        inspection: r.inspection as number,
        damaged: r.damaged as number,
        maintenance: r.maintenance as number,
        retired: r.retired as number,
      },
    })),
  };
};

function units(forced?: 'DAMAGED' | 'MAINTENANCE'): ReportImpl {
  return ({ db, params: p, limit }) => {
    const status = forced ?? p.option ?? 'ALL';
    const rows = db
      .prepare(
        `SELECT a.id, a.asset_tag, a.serial_no, a.status, a.condition, a.notes, rp.id AS pid, rp.name,
                (SELECT ag.rental_no FROM rental_items i JOIN rental_agreements ag ON ag.id = i.agreement_id WHERE i.asset_id = a.id AND i.status = 'OUT') AS rental_no,
                (SELECT MAX(e.occurred_at) FROM asset_events e WHERE e.asset_id = a.id) AS since
         FROM rental_assets a JOIN rental_products rp ON rp.id = a.rental_product_id
         WHERE (? = 'ALL' OR a.status = ?) AND (? IS NULL OR rp.id = ?)
         ORDER BY rp.name, a.asset_tag LIMIT ?`,
      )
      .all(status, status, p.rentalProductId ?? null, p.rentalProductId ?? null, limit + 1) as {
      id: number;
      asset_tag: string;
      serial_no: string;
      status: AssetStatus;
      condition: string;
      notes: string;
      pid: number;
      name: string;
      rental_no: string | null;
      since: string | null;
    }[];
    return {
      columns: [
        col('unit', 'Unit', 'code'),
        col('item', 'Item', 'text'),
        col('serial', 'Serial number', 'text'),
        col('status', 'Status', 'text'),
        col('condition', 'Condition', 'text'),
        col('rental', 'On rental', 'code'),
        col('since', 'Last change', 'datetime'),
        col('notes', 'Notes', 'text'),
      ],
      rows: rows.map((r) => ({
        link: { to: 'rentalProduct' as const, id: r.pid },
        cells: {
          unit: r.asset_tag,
          item: r.name,
          serial: r.serial_no,
          status: ASSET_STATUS[r.status],
          condition: r.condition.charAt(0) + r.condition.slice(1).toLowerCase(),
          rental: r.rental_no ?? '',
          since: r.since,
          notes: r.notes,
        },
      })),
    };
  };
}

const outstanding: ReportImpl = ({ db, params: p, limit }) => {
  const rows = db
    .prepare(
      `SELECT i.id, i.invoice_no, i.business_date, c.name, c.phone, ra.rental_no, i.grand_total, b.outstanding, ${HELD_SQL('ra')} AS held
       FROM invoices i JOIN v_invoice_balances b ON b.invoice_id = i.id JOIN customers c ON c.id = i.customer_id
       LEFT JOIN rental_agreements ra ON ra.id = i.rental_agreement_id
       WHERE i.kind = 'RENTAL' AND b.cancelled = 0 AND b.outstanding > 0 AND (? IS NULL OR i.customer_id = ?)
       ORDER BY i.business_date, i.id LIMIT ?`,
    )
    .all(p.customerId ?? null, p.customerId ?? null, limit + 1) as {
    id: number;
    invoice_no: string;
    business_date: string;
    name: string;
    phone: string;
    rental_no: string | null;
    grand_total: number;
    outstanding: number;
    held: number;
  }[];
  return {
    columns: [
      col('bill', 'Rental bill', 'code'),
      col('rental', 'Rental', 'code'),
      col('customer', 'Customer', 'text'),
      col('phone', 'Phone', 'text'),
      col('date', 'Billed on', 'date'),
      col('amount', 'Amount', 'money', true),
      col('owed', 'Still owed', 'money', true),
      col('held', 'Deposit held on the rental', 'money'),
    ],
    rows: rows.map((r) => ({
      link: { to: 'invoice' as const, id: r.id },
      cells: { bill: r.invoice_no, rental: r.rental_no ?? '', customer: r.name, phone: r.phone, date: r.business_date, amount: r.grand_total, owed: r.outstanding, held: r.held },
    })),
    notes: ['A deposit held can settle these charges when the rental is settled. It is shown for reference and is not deducted.'],
  };
};

interface ChargeRecord {
  created_at: string;
  amount: number;
  calc_json: string;
  rid: number;
  rental_no: string;
  customer_name: string;
  asset_tag: string | null;
  invoice_no: string | null;
}

function charges(db: Parameters<ReportImpl>[0]['db'], type: 'LATE_FEE' | 'DAMAGE', from: string, to: string, limit: number): ChargeRecord[] {
  const { start, end } = rangeInstants(from, to);
  return db
    .prepare(
      `SELECT rc.created_at, rc.amount, rc.calc_json, ra.id AS rid, ra.rental_no, ra.customer_name, ri.asset_tag, i.invoice_no
       FROM rental_charges rc JOIN rental_agreements ra ON ra.id = rc.agreement_id
       LEFT JOIN rental_items ri ON ri.id = rc.item_id LEFT JOIN invoices i ON i.id = rc.invoice_id
       WHERE rc.type = ? AND rc.created_at >= ? AND rc.created_at < ? ORDER BY rc.id LIMIT ?`,
    )
    .all(type, start, end, limit + 1) as ChargeRecord[];
}

const lateFees: ReportImpl = ({ db, params: p, limit }) => {
  const rows = charges(db, 'LATE_FEE', p.from, p.to, limit).map((r) => {
    const calc = JSON.parse(r.calc_json) as { lateMinutes?: number; calculatedAmount?: number; waivedReason?: string };
    const calculated = calc.calculatedAmount ?? r.amount;
    return {
      link: { to: 'rental' as const, id: r.rid },
      cells: {
        when: r.created_at,
        rental: r.rental_no,
        customer: r.customer_name,
        unit: r.asset_tag ?? '',
        late: calc.lateMinutes ? describeDuration(calc.lateMinutes) : '',
        calculated,
        waived: calculated - r.amount,
        charged: r.amount,
        reason: calc.waivedReason ?? '',
        bill: r.invoice_no ?? '',
      },
    };
  });
  return {
    columns: [
      col('when', 'Returned', 'datetime'),
      col('rental', 'Rental', 'code'),
      col('customer', 'Customer', 'text'),
      col('unit', 'Unit', 'code'),
      col('late', 'Late by', 'text'),
      col('calculated', 'Worked out', 'money', true),
      col('waived', 'Reduced or waived', 'money', true),
      col('charged', 'Charged', 'money', true),
      col('reason', 'Reason for reduction', 'text'),
      col('bill', 'Bill', 'code'),
    ],
    rows,
    notes: ['Amounts as charged to the customer (including GST where the rental rates include it).'],
  };
};

const damageCharges: ReportImpl = ({ db, params: p, limit }) => ({
  columns: [
    col('when', 'Charged', 'datetime'),
    col('rental', 'Rental', 'code'),
    col('customer', 'Customer', 'text'),
    col('unit', 'Unit', 'code'),
    col('amount', 'Amount', 'money', true),
    col('details', 'Damage', 'text'),
    col('bill', 'Bill', 'code'),
  ],
  rows: charges(db, 'DAMAGE', p.from, p.to, limit).map((r) => ({
    link: { to: 'rental' as const, id: r.rid },
    cells: {
      when: r.created_at,
      rental: r.rental_no,
      customer: r.customer_name,
      unit: r.asset_tag ?? '',
      amount: r.amount,
      details: (JSON.parse(r.calc_json) as { explanation?: string }).explanation ?? '',
      bill: r.invoice_no ?? '',
    },
  })),
  notes: ['Amounts as charged to the customer (including GST where the rental rates include it).'],
});

const DEPOSIT_LABEL = { COLLECT: 'Collected', APPLY: 'Used for charges', REFUND: 'Refunded' } as const;

const deposits: ReportImpl = ({ db, params: p, limit }) => {
  const type = p.option ?? 'ALL';
  const rows = db
    .prepare(
      `SELECT d.business_date, d.type, d.amount, d.reason, d.reference_no, m.name AS method, ra.id AS rid, ra.rental_no, c.name AS customer, u.username
       FROM deposit_transactions d JOIN rental_agreements ra ON ra.id = d.agreement_id JOIN customers c ON c.id = d.customer_id
       LEFT JOIN payment_methods m ON m.id = d.method_id LEFT JOIN users u ON u.id = d.user_id
       WHERE d.business_date BETWEEN ? AND ? AND (? = 'ALL' OR d.type = ?) ORDER BY d.id LIMIT ?`,
    )
    .all(p.from, p.to, type, type, limit + 1) as {
    business_date: string;
    type: keyof typeof DEPOSIT_LABEL;
    amount: number;
    reason: string;
    reference_no: string;
    method: string | null;
    rid: number;
    rental_no: string;
    customer: string;
    username: string | null;
  }[];
  const sum = (t: string) => rows.filter((r) => r.type === t).reduce((a, r) => a + r.amount, 0);
  return {
    columns: [
      col('date', 'Date', 'date'),
      col('rental', 'Rental', 'code'),
      col('customer', 'Customer', 'text'),
      col('type', 'Movement', 'text'),
      col('collected', 'Collected', 'money', true),
      col('applied', 'Used for charges', 'money', true),
      col('refunded', 'Refunded', 'money', true),
      col('method', 'Method', 'text'),
      col('reason', 'Reason', 'text'),
      col('user', 'By', 'text'),
    ],
    rows: rows.map((r) => ({
      link: { to: 'rental' as const, id: r.rid },
      cells: {
        date: r.business_date,
        rental: r.rental_no,
        customer: r.customer,
        type: DEPOSIT_LABEL[r.type],
        collected: r.type === 'COLLECT' ? r.amount : null,
        applied: r.type === 'APPLY' ? r.amount : null,
        refunded: r.type === 'REFUND' ? r.amount : null,
        method: r.method ? `${r.method}${r.reference_no ? ` · ${r.reference_no}` : ''}` : '',
        reason: r.reason,
        user: r.username ?? '',
      },
    })),
    summary: [
      { label: 'Collected', value: sum('COLLECT'), kind: 'money' },
      { label: 'Used for charges', value: sum('APPLY'), kind: 'money', hint: 'Deductions' },
      { label: 'Refunded', value: sum('REFUND'), kind: 'money' },
    ],
    notes: ['Deposits are money held for customers, not income. Using a deposit for charges pays those charges; it is not extra income.'],
  };
};

const depositsHeld: ReportImpl = ({ db, limit }) => {
  const rows = db
    .prepare(
      `SELECT ra.id, ra.rental_no, ra.status, ra.customer_name, ra.customer_phone,
              SUM(CASE d.type WHEN 'COLLECT' THEN d.amount ELSE 0 END) AS collected,
              SUM(CASE d.type WHEN 'APPLY' THEN d.amount ELSE 0 END) AS applied,
              SUM(CASE d.type WHEN 'REFUND' THEN d.amount ELSE 0 END) AS refunded
       FROM deposit_transactions d JOIN rental_agreements ra ON ra.id = d.agreement_id
       GROUP BY ra.id HAVING collected - applied - refunded > 0 ORDER BY ra.created_at LIMIT ?`,
    )
    .all(limit + 1) as { id: number; rental_no: string; status: string; customer_name: string; customer_phone: string; collected: number; applied: number; refunded: number }[];
  const held = rows.reduce((a, r) => a + r.collected - r.applied - r.refunded, 0);
  return {
    columns: [
      col('rental', 'Rental', 'code'),
      col('status', 'Rental status', 'text'),
      col('customer', 'Customer', 'text'),
      col('phone', 'Phone', 'text'),
      col('collected', 'Collected', 'money', true),
      col('applied', 'Used for charges', 'money', true),
      col('refunded', 'Refunded', 'money', true),
      col('held', 'Held now', 'money', true),
    ],
    rows: rows.map((r) => ({
      link: { to: 'rental' as const, id: r.id },
      cells: {
        rental: r.rental_no,
        status: r.status.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase()),
        customer: r.customer_name,
        phone: r.customer_phone,
        collected: r.collected,
        applied: r.applied,
        refunded: r.refunded,
        held: r.collected - r.applied - r.refunded,
      },
    })),
    summary: [{ label: 'Deposits held', value: held, kind: 'money', hint: 'Owed back to customers' }],
    notes: ['This is a liability: money the shop holds for customers. It equals the deposit liability account (Data health checks it).'],
  };
};

export const rentalReports: Record<string, ReportImpl> = {
  'rentals.active': active,
  'rentals.overdue': overdue,
  'rentals.expectedReturns': expectedReturns,
  'rentals.revenueByPeriod': revenueByPeriod,
  'rentals.revenueByItem': revenueByItem,
  'rentals.revenueByCustomer': revenueByCustomer,
  'rentals.utilization': utilization,
  'rentals.availability': availability,
  'rentals.units': units(),
  'rentals.damaged': units('DAMAGED'),
  'rentals.maintenance': units('MAINTENANCE'),
  'rentals.outstanding': outstanding,
  'rentals.lateFees': lateFees,
  'rentals.damageCharges': damageCharges,
  'rentals.deposits': deposits,
  'rentals.depositsHeld': depositsHeld,
};
