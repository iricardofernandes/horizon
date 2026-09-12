import { Clock } from '@/application/ports/clock'

export class SystemClock extends Clock {
  override now(): Date {
    return new Date()
  }
}
