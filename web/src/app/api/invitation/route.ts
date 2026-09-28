import { type NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'

const apiUrl = process.env.HORIZON_API_URL ?? 'http://localhost:8000'
const token = z.string().regex(/^[A-Za-z0-9_-]{20,100}$/)
const acceptSchema = z.strictObject({
  token,
  name: z.string().max(200),
  password: z.string().min(12).max(1024),
})

function relay(response: Response) {
  return response.arrayBuffer().then(
    (body) =>
      new NextResponse(body, {
        status: response.status,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      }),
  )
}

/** An invitation link, before anyone is signed in (Phase 67): what it invites to. */
export async function GET(request: NextRequest) {
  const parsed = token.safeParse(request.nextUrl.searchParams.get('token'))
  if (!parsed.success) return NextResponse.json({ message: 'Unknown link.' }, { status: 410 })
  return relay(
    await fetch(`${apiUrl}/identity/invitations/lookup?token=${parsed.data}`, {
      cache: 'no-store',
    }),
  )
}

/** Accepting it: the person's own password, once. */
export async function POST(request: Request) {
  const parsed = acceptSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ message: 'Check the fields.' }, { status: 400 })
  return relay(
    await fetch(`${apiUrl}/identity/invitations/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(parsed.data),
      cache: 'no-store',
    }),
  )
}
