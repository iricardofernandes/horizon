import { z } from 'zod'

/** The critical path, in order. `logout` runs whenever `login` did, so sessions do not pile up. */
export const STEPS = ['login', 'dashboard', 'draft', 'cancel', 'logout'] as const
export type Step = (typeof STEPS)[number]

export interface HttpRequest {
  method?: 'GET' | 'POST'
  body?: unknown
  bearer?: string
  idempotencyKey?: string
}
export interface HttpAnswer {
  status: number
  body: unknown
}
export type Http = (path: string, request?: HttpRequest) => Promise<HttpAnswer>

export interface ProbeConfig {
  email: string
  password: string
  /** The workspace to sign in to; the account's first one when absent. */
  tenantId?: string
}

export interface StepResult {
  step: Step
  ok: boolean
  seconds: number
  status: number | null
}
export interface ProbeRun {
  ok: boolean
  steps: StepResult[]
  failure: { step: Step; status: number | null; detail: string } | null
}

export interface ProbeDependencies {
  http: Http
  /** Milliseconds, for durations and the business dates of the draft. */
  now: () => number
  newId: () => string
}

class StepFailed extends Error {
  constructor(
    readonly status: number | null,
    detail: string,
  ) {
    super(detail)
  }
}

const loginAnswer = z.object({
  selectionToken: z.string(),
  workspaces: z.array(z.object({ tenantId: z.uuid() })).min(1),
})
const workspaceAnswer = z.object({ accessToken: z.string(), familyId: z.uuid() })
const orderPage = z.object({ data: z.array(z.object({ id: z.uuid() })).min(1) })
const orderDetail = z.object({
  supplierId: z.uuid(),
  warehouseId: z.uuid(),
  currency: z.string(),
  data: z.array(z.object({ itemId: z.uuid() })).min(1),
})
const created = z.object({ id: z.uuid() })

function expect<T>(answer: HttpAnswer, statuses: number[], schema: z.ZodType<T>): T {
  if (!statuses.includes(answer.status))
    throw new StepFailed(answer.status, `answered ${answer.status}`)
  const parsed = schema.safeParse(answer.body)
  if (!parsed.success) throw new StepFailed(answer.status, 'answered an unexpected body')
  return parsed.data
}

interface Session {
  accessToken: string
  familyId: string
}

async function signIn({ http }: ProbeDependencies, config: ProbeConfig): Promise<Session> {
  const login = expect(
    await http('/auth/login', {
      method: 'POST',
      body: { email: config.email, password: config.password },
    }),
    [200],
    loginAnswer,
  )
  const tenantId = config.tenantId ?? login.workspaces[0]?.tenantId
  if (!login.workspaces.some((workspace) => workspace.tenantId === tenantId))
    throw new StepFailed(200, 'the account has no access to the configured workspace')
  return expect(
    await http('/auth/workspace', {
      method: 'POST',
      body: { selectionToken: login.selectionToken, tenantId },
    }),
    [200],
    workspaceAnswer,
  )
}

async function readDashboard({ http }: ProbeDependencies, session: Session): Promise<void> {
  expect(await http('/reporting/dashboard', { bearer: session.accessToken }), [200], z.unknown())
}

/** A draft purchase order shaped on the newest existing one: its supplier, warehouse and item. */
async function draftOrder(dependencies: ProbeDependencies, session: Session): Promise<string> {
  const { http, now, newId } = dependencies
  const bearer = session.accessToken
  const [newest] = expect(
    await http('/procurement/orders?limit=1', { bearer }),
    [200],
    orderPage,
  ).data
  const template = expect(
    await http(`/procurement/orders/${newest?.id}`, { bearer }),
    [200],
    orderDetail,
  )
  const today = new Date(now()).toISOString().slice(0, 10)
  const answer = await http('/procurement/orders', {
    method: 'POST',
    bearer,
    idempotencyKey: newId(),
    body: {
      supplierId: template.supplierId,
      warehouseId: template.warehouseId,
      currency: template.currency,
      lines: [{ lineId: newId(), itemId: template.data[0]?.itemId, quantity: '1', unitPrice: '1' }],
      issuedOn: today,
      expectedOn: today,
      notes: `PROBE-${today}: synthetic probe, cancelled in the same run`,
    },
  })
  return expect(answer, [200, 201], created).id
}

async function cancelOrder(
  { http, newId }: ProbeDependencies,
  session: Session,
  orderId: string,
): Promise<void> {
  expect(
    await http(`/procurement/orders/${orderId}/cancel`, {
      method: 'POST',
      bearer: session.accessToken,
      idempotencyKey: newId(),
      body: { reason: 'synthetic probe' },
    }),
    [200, 201, 204],
    z.unknown(),
  )
}

async function signOut({ http }: ProbeDependencies, session: Session): Promise<void> {
  expect(
    await http('/auth/logout', {
      method: 'POST',
      bearer: session.accessToken,
      body: { familyId: session.familyId },
    }),
    [200, 204],
    z.unknown(),
  )
}

async function timed<T>(
  dependencies: ProbeDependencies,
  step: Step,
  steps: StepResult[],
  work: () => Promise<T>,
): Promise<T> {
  const started = dependencies.now()
  const seconds = () => (dependencies.now() - started) / 1000
  try {
    const value = await work()
    steps.push({ step, ok: true, seconds: seconds(), status: null })
    return value
  } catch (error) {
    const failed =
      error instanceof StepFailed ? error : new StepFailed(null, `could not reach: ${error}`)
    steps.push({ step, ok: false, seconds: seconds(), status: failed.status })
    throw Object.assign(failed, { step })
  }
}

/** One run of the critical path. Never throws: a failure names its step and the status. */
export async function runProbe(
  dependencies: ProbeDependencies,
  config: ProbeConfig,
): Promise<ProbeRun> {
  const steps: StepResult[] = []
  let session: Session | null = null
  let failure: ProbeRun['failure'] = null
  const fail = (error: unknown) => {
    const failed = error as StepFailed & { step: Step }
    failure ??= { step: failed.step, status: failed.status, detail: failed.message }
  }
  try {
    session = await timed(dependencies, 'login', steps, () => signIn(dependencies, config))
    const signedIn = session
    await timed(dependencies, 'dashboard', steps, () => readDashboard(dependencies, signedIn))
    const orderId = await timed(dependencies, 'draft', steps, () =>
      draftOrder(dependencies, signedIn),
    )
    await timed(dependencies, 'cancel', steps, () => cancelOrder(dependencies, signedIn, orderId))
  } catch (error) {
    fail(error)
  }
  if (session) {
    const signedIn = session
    await timed(dependencies, 'logout', steps, () => signOut(dependencies, signedIn)).catch(fail)
  }
  return { ok: failure === null, steps, failure }
}
