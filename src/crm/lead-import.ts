// growth-os T-G2-07 generic lead import: pure parsing/mapping helpers.
// No I/O here so CSV parsing and webhook payload mapping stay unit-testable;
// the service layer owns persistence and the HTTP layer owns transport.

import { GrowthError } from '../research/errors.js';
import type { ImportedLeadInput } from './types.js';

/**
 * Parse CSV text into rows of string fields. Handles quoted fields (with
 * embedded commas/newlines), doubled-quote escaping and CRLF/LF line ends.
 * Blank separator lines are dropped.
 */
export function parseCsv(text: string): string[][] {
  const src = text.startsWith('\uFEFF') ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && (r[0] ?? '').trim() === ''));
}

function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

const TITLE_KEYS = ['title', 'name', 'subject', 'lead_title'];
const SUMMARY_KEYS = ['summary', 'message', 'body', 'content'];
const CONTACT_NAME_KEYS = ['contact_name', 'contact', 'customer_name'];
const CONTACT_EMAIL_KEYS = ['contact_email', 'email', 'email_address'];
const COMPANY_KEYS = ['company'];
const SCORE_KEYS = ['score'];

type ColumnKey = 'title' | 'summary' | 'contactName' | 'contactEmail' | 'company' | 'score';

/** Map header-driven CSV rows into import inputs; rows without a title are skipped. */
export function csvToImportInputs(rows: string[][], sourceRef: string): ImportedLeadInput[] {
  if (rows.length === 0) return [];
  const header = (rows[0] ?? []).map(normalizeHeader);
  const column = (keys: string[]): number => header.findIndex((h) => keys.includes(h));
  const index: Record<ColumnKey, number> = {
    title: column(TITLE_KEYS),
    summary: column(SUMMARY_KEYS),
    contactName: column(CONTACT_NAME_KEYS),
    contactEmail: column(CONTACT_EMAIL_KEYS),
    company: column(COMPANY_KEYS),
    score: column(SCORE_KEYS),
  };

  const out: ImportedLeadInput[] = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    if (!cells) continue;
    const title = index.title >= 0 ? (cells[index.title] ?? '').trim() : '';
    if (!title) continue;
    const item: ImportedLeadInput = { sourceRef, title };

    const assign = (key: ColumnKey, target: keyof ImportedLeadInput, numeric = false): void => {
      const i = index[key];
      if (i < 0) return;
      const raw = (cells[i] ?? '').trim();
      if (!raw) return;
      if (numeric) {
        const n = Number(raw);
        if (Number.isFinite(n)) item[target] = n as never;
      } else {
        item[target] = raw as never;
      }
    };

    assign('summary', 'summary');
    assign('contactName', 'contactName');
    assign('contactEmail', 'contactEmail');
    assign('company', 'company');
    assign('score', 'score', true);
    out.push(item);
  }
  return out;
}

/** Map a generic webhook JSON payload into an import input (vendor-neutral). */
export function webhookToImportInput(
  body: Record<string, unknown>,
  sourceRef: string,
): ImportedLeadInput {
  const pick = (keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = body[k];
      if (v !== undefined && v !== null && String(v).trim() !== '') return String(v);
    }
    return undefined;
  };

  const title = pick(TITLE_KEYS);
  if (!title) throw new GrowthError('VALIDATION_FAILED', 'webhook lead title is required', 400);

  const item: ImportedLeadInput = { sourceRef, title: title.trim() };
  const summary = pick(SUMMARY_KEYS);
  if (summary) item.summary = summary;
  const contactName = pick(['contact_name', 'contactname', 'customer_name']);
  if (contactName) item.contactName = contactName;
  const contactEmail = pick(['contact_email', 'contactemail', 'email']);
  if (contactEmail) item.contactEmail = contactEmail;
  const company = pick(COMPANY_KEYS);
  if (company) item.company = company;
  const scoreRaw = pick(SCORE_KEYS);
  if (scoreRaw !== undefined) {
    const n = Number(scoreRaw);
    if (Number.isFinite(n)) item.score = n;
  }
  return item;
}
