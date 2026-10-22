import type { Db } from '../db/connection';
import type { Tx } from '../db/tx';
import {
  defaultSettings,
  settingsSchemas,
  SETTINGS_SECTIONS,
  type AllSettings,
  type SettingsSection,
  type ShopProfile,
} from '@shared/settings';

/** The shop profile before the setup wizard has run. */
const EMPTY_SHOP: ShopProfile = {
  name: '',
  addressLine1: '',
  addressLine2: '',
  city: '',
  pincode: '',
  stateCode: '',
  phone: '',
  email: '',
  gstin: '',
  invoiceFooter: '',
};

/**
 * Reads every settings section, filling in defaults for missing keys. A stored
 * value that no longer validates (for example after an upgrade) falls back to defaults
 * for the missing fields instead of breaking the application.
 */
export function getAllSettings(db: Db): AllSettings {
  const rows = db.prepare('SELECT key, value_json FROM settings').all() as { key: string; value_json: string }[];
  const stored = new Map(rows.map((r) => [r.key, JSON.parse(r.value_json) as unknown]));
  const defaults = defaultSettings();
  const out = { shop: EMPTY_SHOP, ...defaults } as AllSettings;
  for (const section of SETTINGS_SECTIONS) {
    const raw = stored.get(section);
    if (raw === undefined) continue;
    const base = section === 'shop' ? EMPTY_SHOP : defaults[section as Exclude<SettingsSection, 'shop'>];
    const parsed = settingsSchemas[section].safeParse({ ...base, ...(raw as object) });
    (out as Record<string, unknown>)[section] = parsed.success ? parsed.data : { ...base, ...(raw as object) };
  }
  return out;
}

export function getSettingsSection<K extends SettingsSection>(db: Db, section: K): AllSettings[K] {
  return getAllSettings(db)[section];
}

/** Validates and stores one section, recording the previous and new values in the audit log. */
export function updateSettingsSection<K extends SettingsSection>(
  tx: Tx,
  section: K,
  value: unknown,
  reason?: string | null,
): AllSettings[K] {
  const parsed = settingsSchemas[section].parse(value) as AllSettings[K];
  const before = tx.db.prepare('SELECT value_json FROM settings WHERE key = ?').get(section) as
    | { value_json: string }
    | undefined;
  const beforeValue = before ? (JSON.parse(before.value_json) as unknown) : null;
  if (before && JSON.stringify(beforeValue) === JSON.stringify(parsed)) return parsed;

  tx.db
    .prepare(
      `INSERT INTO settings (key, value_json, updated_at, updated_by) VALUES (?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at,
         updated_by = excluded.updated_by`,
    )
    .run(section, JSON.stringify(parsed), tx.nowIso, tx.actor.userId);
  tx.audit({
    module: 'settings',
    entityType: 'settings',
    entityId: section,
    action: before ? 'UPDATE' : 'CREATE',
    before: beforeValue,
    after: parsed,
    reason: reason ?? null,
  });
  return parsed;
}
