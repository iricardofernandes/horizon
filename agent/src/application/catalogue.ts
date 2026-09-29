import { createHash } from 'node:crypto'
import { z } from 'zod'

/**
 * The declared catalogue of what a tenant's agent may read (ADR 0065).
 *
 * One entry per route. There is no tool that takes a path, and no tool writes: every entry
 * is a `GET` through the gateway, with the scope the owning module will itself check again.
 * Each input schema mirrors the route's own query, because several modules refuse a
 * parameter they do not know.
 */
export type CatalogueModule =
  | 'parties'
  | 'catalog'
  | 'sales'
  | 'inventory'
  | 'procurement'
  | 'financial'
  | 'treasury'
  | 'crm'
  | 'fiscal'
  | 'reporting'
  | 'knowledge'

export interface ToolEntry {
  readonly name: string
  readonly module: CatalogueModule
  /** `draft` tools create a record a person must still take further (ADR 0066). */
  readonly kind: 'list' | 'get' | 'draft'
  readonly description: string
  /** Gateway path; `{param}` segments are filled from validated arguments only. */
  readonly path: string
  readonly input: z.ZodRawShape
  /** What a draft creates, as the agent's log and the lists name it. */
  readonly record?: string
  /** Rows asked for when the agent names no limit, if fewer than the cap. */
  readonly defaultLimit?: number
}

const id = z.uuid().describe('The record id')
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe('A calendar date, YYYY-MM-DD')
const instant = z.iso.datetime({ offset: true }).describe('An instant, ISO 8601 with offset')
const limit = (max: number) => z.number().int().min(1).max(max).optional().describe('Rows wanted')
const offset = z.number().int().min(0).max(100_000).optional().describe('Rows to skip')
const cursor = z.string().min(1).max(2048).optional().describe('The nextCursor of a previous page')

const TITLE_VIEWS = [
  'all',
  'forecast',
  'draft',
  'awaiting-approval',
  'open',
  'overdue',
  'settled',
  'closed',
] as const
const titleFilter = {
  view: z.enum(TITLE_VIEWS).optional(),
  search: z.string().max(100).optional(),
  partyId: z.uuid().optional(),
  today: date.optional(),
  limit: limit(100),
  offset,
}

export const REPORT_NAMES = [
  'cash-position',
  'order-to-cash',
  'procure-to-pay',
  'pipeline-to-revenue',
] as const

export const CATALOGUE: readonly ToolEntry[] = [
  {
    name: 'list_parties',
    module: 'parties',
    kind: 'list',
    description:
      'List parties (customers, suppliers, carriers, prospects, partners), newest first.',
    path: '/parties/parties',
    input: {
      role: z.enum(['customer', 'supplier', 'carrier', 'prospect', 'partner']).optional(),
      search: z.string().trim().min(2).max(100).optional(),
      limit: limit(200),
    },
  },
  {
    name: 'get_party',
    module: 'parties',
    kind: 'get',
    description: 'Read one party: names, documents, roles, contacts and addresses.',
    path: '/parties/parties/{id}',
    input: { id },
  },
  {
    name: 'list_items',
    module: 'catalog',
    kind: 'list',
    description: 'List catalogue items (products and services), searchable by SKU or name.',
    path: '/catalog/items',
    input: { search: z.string().trim().min(1).max(100).optional(), limit: limit(100), cursor },
  },
  {
    name: 'get_item',
    module: 'catalog',
    kind: 'get',
    description: 'Read one catalogue item.',
    path: '/catalog/items/{id}',
    input: { id },
  },
  {
    name: 'list_price_lists',
    module: 'catalog',
    kind: 'list',
    description: 'List price lists.',
    path: '/catalog/price-lists',
    input: { limit: limit(100), cursor },
  },
  {
    name: 'list_quotes',
    module: 'sales',
    kind: 'list',
    description: 'List sales quotes.',
    path: '/sales/quotes',
    input: {},
  },
  {
    name: 'get_quote',
    module: 'sales',
    kind: 'get',
    description: 'Read one sales quote with its lines.',
    path: '/sales/quotes/{id}',
    input: { id },
  },
  {
    name: 'list_sales_orders',
    module: 'sales',
    kind: 'list',
    description: 'List sales orders.',
    path: '/sales/orders',
    input: {},
  },
  {
    name: 'get_sales_order',
    module: 'sales',
    kind: 'get',
    description: 'Read one sales order with its lines.',
    path: '/sales/orders/{id}',
    input: { id },
  },
  {
    name: 'sales_orders_summary',
    module: 'sales',
    kind: 'get',
    description: 'Sales orders counted and totalled by status and currency.',
    path: '/sales/orders/summary',
    input: {},
  },
  {
    name: 'list_service_orders',
    module: 'sales',
    kind: 'list',
    description: 'List service orders.',
    path: '/sales/service-orders',
    input: {},
  },
  {
    name: 'list_contracts',
    module: 'sales',
    kind: 'list',
    description: 'List recurring service contracts.',
    path: '/sales/contracts',
    input: {},
  },
  {
    name: 'list_warehouses',
    module: 'inventory',
    kind: 'list',
    description: 'List warehouses.',
    path: '/inventory/warehouses',
    input: {},
  },
  {
    name: 'stock_position',
    module: 'inventory',
    kind: 'list',
    description: 'Stock on hand, reserved and available, by item and warehouse.',
    path: '/inventory/stock-position',
    input: {
      warehouseId: z.uuid().optional(),
      itemId: z.uuid().optional(),
      limit: limit(200),
      offset,
    },
  },
  {
    name: 'stock_valuation',
    module: 'inventory',
    kind: 'get',
    description: 'Stock valued at cost, now, optionally for one warehouse.',
    path: '/inventory/stock-valuation',
    input: { warehouseId: z.uuid().optional() },
  },
  {
    name: 'list_requisitions',
    module: 'procurement',
    kind: 'list',
    description: 'List purchase requisitions.',
    path: '/procurement/requisitions',
    input: {
      status: z
        .enum(['draft', 'submitted', 'approved', 'rejected', 'ordered', 'cancelled'])
        .optional(),
      limit: limit(200),
      offset,
    },
  },
  {
    name: 'get_requisition',
    module: 'procurement',
    kind: 'get',
    description: 'Read one purchase requisition.',
    path: '/procurement/requisitions/{id}',
    input: { id },
  },
  {
    name: 'list_purchase_orders',
    module: 'procurement',
    kind: 'list',
    description: 'List purchase orders.',
    path: '/procurement/orders',
    input: {
      status: z
        .enum(['draft', 'pending', 'approved', 'rejected', 'cancelled', 'received', 'closed'])
        .optional(),
      supplierId: z.uuid().optional(),
      limit: limit(200),
      offset,
    },
  },
  {
    name: 'get_purchase_order',
    module: 'procurement',
    kind: 'get',
    description: 'Read one purchase order with its lines and receipts.',
    path: '/procurement/orders/{id}',
    input: { id },
  },
  {
    name: 'list_suppliers',
    module: 'procurement',
    kind: 'list',
    description: 'List suppliers as purchasing knows them.',
    path: '/procurement/suppliers',
    input: { limit: limit(500) },
  },
  {
    name: 'list_receivables',
    module: 'financial',
    kind: 'list',
    description: 'List receivables (money owed to the company), by view.',
    path: '/financial/receivables',
    input: titleFilter,
  },
  {
    name: 'get_receivable',
    module: 'financial',
    kind: 'get',
    description: 'Read one receivable with its installments and settlements.',
    path: '/financial/receivables/{id}',
    input: { id },
  },
  {
    name: 'list_payables',
    module: 'financial',
    kind: 'list',
    description: 'List payables (money the company owes), by view.',
    path: '/financial/payables',
    input: titleFilter,
  },
  {
    name: 'get_payable',
    module: 'financial',
    kind: 'get',
    description: 'Read one payable with its installments and settlements.',
    path: '/financial/payables/{id}',
    input: { id },
  },
  {
    name: 'list_bank_accounts',
    module: 'treasury',
    kind: 'list',
    description: 'List bank and cash accounts with their balances on a date (today by default).',
    path: '/treasury/accounts',
    input: { asOf: date.optional() },
  },
  {
    name: 'get_bank_account_statement',
    module: 'treasury',
    kind: 'get',
    description: 'An account statement between two value dates, with the running balance.',
    path: '/treasury/accounts/{id}/statement',
    input: { id, from: date.optional(), to: date.optional() },
  },
  {
    name: 'list_crm_accounts',
    module: 'crm',
    kind: 'list',
    description: 'List CRM accounts.',
    path: '/crm/accounts',
    input: {
      search: z.string().trim().max(160).optional(),
      role: z.enum(['prospect', 'customer', 'partner']).optional(),
      ownerId: z.uuid().optional(),
      status: z.enum(['active', 'inactive', 'erased']).optional(),
      limit: limit(200),
      offset,
    },
  },
  {
    name: 'get_crm_account',
    module: 'crm',
    kind: 'get',
    description: 'Read one CRM account with its contacts.',
    path: '/crm/accounts/{id}',
    input: { id },
  },
  {
    name: 'list_opportunities',
    module: 'crm',
    kind: 'list',
    description: 'List opportunities, by pipeline, stage, status, owner or account.',
    path: '/crm/opportunities',
    input: {
      pipelineId: z.uuid().optional(),
      stageId: z.uuid().optional(),
      status: z.enum(['open', 'won', 'lost']).optional(),
      ownerId: z.uuid().optional(),
      accountId: z.uuid().optional(),
      limit: limit(200),
      offset,
    },
  },
  {
    name: 'get_opportunity',
    module: 'crm',
    kind: 'get',
    description: 'Read one opportunity.',
    path: '/crm/opportunities/{id}',
    input: { id },
  },
  {
    name: 'list_tasks',
    module: 'crm',
    kind: 'list',
    description: 'List CRM tasks.',
    path: '/crm/tasks',
    input: {
      assigneeId: z.uuid().optional(),
      accountId: z.uuid().optional(),
      status: z.enum(['open', 'completed', 'cancelled']).optional(),
      dueBefore: instant.optional(),
      limit: limit(200),
      offset,
    },
  },
  {
    name: 'list_fiscal_documents',
    module: 'fiscal',
    kind: 'list',
    description: 'List fiscal documents (NF-e, NFC-e, NFS-e), newest first. Simulation only.',
    path: '/fiscal/documents',
    input: { model: z.enum(['55', '65', 'nfse']).optional(), limit: limit(100), cursor },
  },
  {
    name: 'list_reports',
    module: 'reporting',
    kind: 'list',
    description: 'The cross-module reports that can be read at a cutoff.',
    path: '/reporting/reports',
    input: {},
  },
  {
    name: 'get_report',
    module: 'reporting',
    kind: 'get',
    description: 'Read a cross-module report at a cutoff, with whether the cutoff is settled.',
    path: '/reporting/reports/{name}',
    input: {
      name: z.enum(REPORT_NAMES),
      cutoff: instant.optional(),
      currency: z
        .string()
        .regex(/^[A-Z]{3}$/)
        .optional(),
      from: date.optional(),
      to: date.optional(),
    },
  },
  {
    name: 'reporting_dashboard',
    module: 'reporting',
    kind: 'get',
    description: 'The headline figures of every report at a cutoff.',
    path: '/reporting/dashboard',
    input: { cutoff: instant.optional() },
  },
  // --- drafts (ADR 0066): each creates a record a person must still take further -----
  {
    name: 'search_documents',
    module: 'knowledge',
    kind: 'list',
    description:
      'Search the workspace’s attached documents by meaning and by words. Each result cites its attachment, the record it belongs to, its position in the file and the excerpt; only the modules this key reaches are searched, and a record can be named to search its attachments alone.',
    path: '/knowledge/search',
    defaultLimit: 10,
    input: {
      q: z.string().trim().min(2).max(200).describe('What to look for, in any language'),
      limit: z.number().int().min(1).max(20).optional().describe('Results wanted'),
      module: z.enum(['parties', 'procurement', 'financial', 'sales', 'crm']).optional(),
      recordType: z
        .enum(['party', 'purchase-order', 'receivable', 'payable', 'service-order', 'opportunity'])
        .optional(),
      recordId: z.uuid().optional().describe('With module and recordType: that record alone'),
    },
  },
  {
    name: 'draft_quote',
    module: 'sales',
    kind: 'draft',
    record: 'quote',
    description:
      'Draft a sales quote for a customer. It stays a draft until a person sends or accepts it.',
    path: '/sales/quotes',
    input: {
      customerId: z.uuid(),
      opportunityId: z.uuid().optional(),
      lines: z
        .array(
          z.strictObject({ itemId: z.uuid(), quantity: z.string().regex(/^\d+(?:\.\d{1,6})?$/) }),
        )
        .min(1)
        .max(100),
      terms: z
        .strictObject({
          discount: z
            .string()
            .regex(/^\d{1,18}$/)
            .optional(),
          freight: z
            .string()
            .regex(/^\d{1,18}$/)
            .optional(),
          paymentTermDays: z.array(z.number().int().min(0).max(365)).min(1).max(12).optional(),
          notes: z.string().max(500).optional(),
        })
        .optional(),
    },
  },
  {
    name: 'draft_purchase_requisition',
    module: 'procurement',
    kind: 'draft',
    record: 'requisition',
    description: 'Draft a purchase requisition. A person submits it, and someone else approves it.',
    path: '/procurement/requisitions',
    input: {
      warehouseId: z.uuid(),
      neededBy: date,
      justification: z.string().max(500).optional(),
      lines: z
        .array(
          z.strictObject({
            itemId: z.uuid(),
            description: z.string().trim().min(1).max(160).optional(),
            quantity: z.string().regex(/^\d{1,15}(\.\d{1,6})?$/),
          }),
        )
        .min(1)
        .max(200),
    },
  },
  {
    name: 'draft_payable',
    module: 'financial',
    kind: 'draft',
    record: 'payable',
    description:
      'Draft a payable from a supplier document. It is never posted here: a person posts it.',
    path: '/financial/payables',
    input: {
      partyId: z.uuid(),
      documentNumber: z.string().trim().min(1).max(40),
      description: z.string().max(500).optional(),
      currency: z.string().regex(/^[A-Z]{3}$/),
      categoryId: z.uuid().optional(),
      issuedOn: date,
      competenceOn: date.optional(),
      installments: z
        .array(z.strictObject({ dueOn: date, amount: z.string().regex(/^\d{1,18}$/) }))
        .min(1)
        .max(120),
    },
  },
  {
    name: 'create_crm_task',
    module: 'crm',
    kind: 'draft',
    record: 'task',
    description:
      'Create a CRM task about an account, contact or opportunity, for the key issuer unless another assignee is named.',
    path: '/crm/tasks',
    input: {
      subject: z.strictObject({
        type: z.enum(['account', 'contact', 'opportunity']),
        id: z.uuid(),
      }),
      title: z.string().min(1).max(200),
      dueAt: instant,
      remindAt: instant.optional(),
      assigneeId: z.uuid().optional(),
    },
  },
  {
    name: 'record_crm_activity',
    module: 'crm',
    kind: 'draft',
    record: 'activity',
    description: 'Record a call, meeting, email or visit on an account, contact or opportunity.',
    path: '/crm/activities',
    input: {
      subject: z.strictObject({
        type: z.enum(['account', 'contact', 'opportunity']),
        id: z.uuid(),
      }),
      kind: z.enum(['call', 'meeting', 'email', 'visit']),
      occurredAt: instant,
      title: z.string().min(1).max(200),
      summary: z.string().max(5000).optional(),
      contactIds: z.array(z.uuid()).max(20).optional(),
    },
  },
  {
    name: 'write_crm_note',
    module: 'crm',
    kind: 'draft',
    record: 'note',
    description: 'Write a note on an account, contact or opportunity.',
    path: '/crm/notes',
    input: {
      subject: z.strictObject({
        type: z.enum(['account', 'contact', 'opportunity']),
        id: z.uuid(),
      }),
      body: z.string().min(1).max(12_000),
    },
  },
]

/**
 * The only routes a tool may write to (ADR 0066): creations of records a person must still
 * take further. A new write tool means editing this list and its test, in review.
 */
export const DRAFT_ROUTES: readonly string[] = [
  '/sales/quotes',
  '/procurement/requisitions',
  '/financial/payables',
  '/crm/tasks',
  '/crm/activities',
  '/crm/notes',
]

/** Decisions, postings and access: no tool path may ever look like one of these. */
export const DENIED_ROUTE =
  /approve|reject|submit|post(?:s|ing)?\b|settle|cancel|revers|issue|convert|realis|confirm|dispatch|transmi|api-keys|roles|settings|erase|import|export|delegation|polic/

/** A key reaches a module's tools with `<module>:read` or `<module>:write` (ADR 0064). */
export function toolsFor(scopes: readonly string[]): readonly ToolEntry[] {
  return CATALOGUE.filter((tool) =>
    tool.kind === 'draft'
      ? scopes.includes(`${tool.module}:write`)
      : scopes.includes(`${tool.module}:read`) || scopes.includes(`${tool.module}:write`),
  )
}

const PARAM = /\{(\w+)\}/g

/**
 * The gateway request a tool's validated arguments make. Path parameters are UUIDs or a
 * closed enum, and are encoded anyway, so no argument can change the route; everything else
 * goes to the query. A list's `limit` never exceeds the agent's row cap.
 */
export function requestFor(
  tool: ToolEntry,
  args: Readonly<Record<string, unknown>>,
  maxRows: number,
): { path: string; query: Record<string, string> } {
  const inPath = new Set<string>()
  const path = tool.path.replace(PARAM, (_, name: string) => {
    inPath.add(name)
    const value = args[name]
    if (typeof value !== 'string' || value.length === 0)
      throw new Error(`the ${name} argument is required`)
    return encodeURIComponent(value)
  })
  const query: Record<string, string> = {}
  for (const [name, value] of Object.entries(args)) {
    if (inPath.has(name) || value === undefined || value === null) continue
    if (!(name in tool.input)) continue
    query[name] = String(name === 'limit' ? Math.min(Number(value), maxRows) : value)
  }
  if (tool.kind === 'list' && 'limit' in tool.input && query.limit === undefined)
    query.limit = String(Math.min(tool.defaultLimit ?? maxRows, maxRows))
  return { path, query }
}

/** A UUID derived from a digest, so a retried call sends the very same line ids. */
function derivedUuid(seed: string, index: number): string {
  const hex = createHash('sha256').update(`${seed}:${index}`).digest('hex')
  const variant = ((Number.parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(18, 20)}-${hex.slice(20, 32)}`
}

/**
 * The body a draft tool's validated arguments make: what the route asks for, with what the
 * agent derives — line ids from the call's own digest, and a task's assignee (the key's
 * issuer unless another is named).
 */
export function draftBody(
  tool: ToolEntry,
  args: Readonly<Record<string, unknown>>,
  derive: { readonly seed: string; readonly issuer: string | null },
): Record<string, unknown> {
  const body: Record<string, unknown> = { ...args }
  if (Array.isArray(args.lines))
    body.lines = (args.lines as Record<string, unknown>[]).map((line, index) => ({
      lineId: derivedUuid(derive.seed, index),
      ...line,
    }))
  if (tool.name === 'create_crm_task' && body.assigneeId === undefined) {
    if (!derive.issuer) throw new Error('the task needs an assigneeId')
    body.assigneeId = derive.issuer
  }
  return body
}
