import { describe, expect, it } from 'vitest';
import { CrmRepository } from '../src/crm/repository.js';
import { LeadService } from '../src/crm/lead-service.js';
import { csvToImportInputs, parseCsv, webhookToImportInput } from '../src/crm/lead-import.js';
import { LocalWatch } from '../src/crm/watch.js';
import { SqliteDriver } from '../src/storage/sqlite/sqlite-driver.js';
import { migrateUp } from '../src/storage/migrate.js';

const FIXED_NOW = '2026-11-01T00:00:00Z';

async function makeStack() {
  const driver = new SqliteDriver(':memory:');
  await migrateUp(driver);
  const crmRepo = new CrmRepository(driver);
  const leadService = new LeadService({
    repo: crmRepo,
    signals: { listSignals: async () => [] },
    watch: new LocalWatch(crmRepo),
    now: () => FIXED_NOW,
  });
  return { driver, crmRepo, leadService };
}

describe('parseCsv', () => {
  it('splits simple rows and fields', () => {
    expect(parseCsv('a,b,c\n1,2,3')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  it('handles CRLF and quoted fields with embedded commas', () => {
    expect(parseCsv('title,email\r\n"Hello, World",a@x.com')).toEqual([
      ['title', 'email'],
      ['Hello, World', 'a@x.com'],
    ]);
  });

  it('escapes doubled quotes and drops blank separator lines', () => {
    expect(parseCsv('a\n\n"q""x"\n')).toEqual([['a'], ['q"x']]);
  });
});

describe('csvToImportInputs', () => {
  it('maps header columns and skips rows without a title', () => {
    const rows = parseCsv(
      'title,contact_email,company,score\nLead A,a@x.com,Acme,72\n,b@y.com,NoName,10',
    );
    const inputs = csvToImportInputs(rows, 'csv:batch-1');
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({
      sourceRef: 'csv:batch-1',
      title: 'Lead A',
      contactEmail: 'a@x.com',
      company: 'Acme',
      score: 72,
    });
  });

  it('accepts alternative header names', () => {
    const rows = parseCsv('name,message\nLead B,Body text');
    const inputs = csvToImportInputs(rows, 'csv:batch-2');
    expect(inputs[0]).toMatchObject({ title: 'Lead B', summary: 'Body text' });
  });
});

describe('webhookToImportInput', () => {
  it('maps a vendor-neutral payload', () => {
    const input = webhookToImportInput(
      { subject: 'RFQ 1', body: 'Need 100 units', email: 'b@z.com', company: 'Z Co' },
      'webhook:rfq',
    );
    expect(input).toMatchObject({
      sourceRef: 'webhook:rfq',
      title: 'RFQ 1',
      summary: 'Need 100 units',
      contactEmail: 'b@z.com',
      company: 'Z Co',
    });
  });

  it('fails without a title', () => {
    let thrown: unknown;
    try {
      webhookToImportInput({ summary: 'no title' }, 'webhook');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('LeadService.importLead', () => {
  it('creates an imported lead entering the state machine as new', async () => {
    const { leadService } = await makeStack();
    const lead = await leadService.importLead({ sourceRef: 'webhook:src', title: 'Inbound RFQ', score: 55 });
    expect(lead).toMatchObject({
      status: 'new',
      sourceType: 'import',
      sourceRef: 'webhook:src',
      score: 55,
    });
    const reread = await leadService.getLead(lead.id);
    expect(reread.sourceRef).toBe('webhook:src');
  });

  it('creates and attaches a contact when contact details are present', async () => {
    const { leadService, crmRepo } = await makeStack();
    const lead = await leadService.importLead({
      sourceRef: 'webhook:src',
      title: 'RFQ with person',
      contactName: 'Jane Buyer',
      contactEmail: 'jane@buyer.com',
      company: 'Buyer Co',
    });
    expect(lead.contactId).toBeDefined();
    const contacts = await crmRepo.listContacts();
    expect(contacts[0]).toMatchObject({
      name: 'Jane Buyer',
      email: 'jane@buyer.com',
      sourceType: 'import',
      sourceRefs: ['webhook:src'],
    });
  });

  it('rejects missing sourceRef/title and out-of-range score', async () => {
    const { leadService } = await makeStack();
    await expect(leadService.importLead({ sourceRef: '', title: 'X' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(leadService.importLead({ sourceRef: 's', title: ' ' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(
      leadService.importLead({ sourceRef: 's', title: 'X', score: 120 }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('reuses the existing state machine after import', async () => {
    const { leadService } = await makeStack();
    const lead = await leadService.importLead({ sourceRef: 'webhook:src', title: 'Movable' });
    const qualified = await leadService.transitionLead(lead.id, 'qualified', 'imported rfq');
    expect(qualified.status).toBe('qualified');
    const events = await leadService.listLeadEvents(lead.id);
    expect(events).toHaveLength(1);
  });
});

describe('LeadService.importLeadsBatch', () => {
  it('imports multiple rows atomically', async () => {
    const { leadService } = await makeStack();
    const leads = await leadService.importLeadsBatch([
      { sourceRef: 'csv:b', title: 'Row 1', contactName: 'A', contactEmail: 'a@x.com' },
      { sourceRef: 'csv:b', title: 'Row 2', score: 40 },
    ]);
    expect(leads).toHaveLength(2);
    expect(leads.map((l) => l.status)).toEqual(['new', 'new']);
    expect(await leadService.listLeads()).toHaveLength(2);
  });

  it('rolls the whole batch back when one row is invalid', async () => {
    const { leadService, crmRepo } = await makeStack();
    await expect(
      leadService.importLeadsBatch([
        { sourceRef: 'csv:b', title: 'Good row' },
        { sourceRef: 'csv:b', title: ' ' },
      ]),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(await crmRepo.listLeads()).toHaveLength(0);
  });
});
