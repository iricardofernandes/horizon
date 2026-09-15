export class RateLimiter {
  private readonly buckets = new Map<string, number[]>()

  constructor(
    private readonly limit: number,
    private readonly now: () => number = Date.now,
  ) {}

  assertAllowed(caller: string, tool: string): void {
    const key = `${caller}:${tool}`
    const cutoff = this.now() - 60_000
    const recent = (this.buckets.get(key) ?? []).filter((timestamp) => timestamp > cutoff)
    if (recent.length >= this.limit) throw new Error(`Rate limit exceeded for ${tool}`)
    recent.push(this.now())
    this.buckets.set(key, recent)
  }
}
