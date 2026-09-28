import { connect } from 'node:net'
import type { Scanner, ScanVerdict } from '@/application/ports'

/** The EICAR anti-virus test string: harmless, and flagged by every scanner by agreement. */
export const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'

/**
 * The deterministic scanner of CI and tests (ADR 0060): it finds the EICAR test string and
 * nothing else. It is not protection; ClamAV is.
 */
export class EicarScanner implements Scanner {
  async scan(bytes: Buffer): Promise<ScanVerdict> {
    return bytes.includes(EICAR, 0, 'latin1')
      ? { clean: false, finding: 'Eicar-Test-Signature' }
      : { clean: true }
  }
}

const CHUNK = 64 * 1024

/** What `clamd` answered to `INSTREAM`: `stream: OK`, `stream: <name> FOUND`, or an error. */
export function verdictOf(reply: string): ScanVerdict {
  const answer = reply.replace(/\0/g, '').trim()
  if (/^stream: OK$/.test(answer)) return { clean: true }
  const found = /^stream: (.+) FOUND$/.exec(answer)
  if (found?.[1]) return { clean: false, finding: found[1] }
  throw new Error('clamd did not scan the file')
}

/** The `INSTREAM` request: the command, the bytes in length-prefixed chunks, then a zero. */
export function instreamOf(bytes: Buffer): Buffer {
  const parts: Buffer[] = [Buffer.from('zINSTREAM\0', 'latin1')]
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    const chunk = bytes.subarray(offset, offset + CHUNK)
    const length = Buffer.alloc(4)
    length.writeUInt32BE(chunk.length)
    parts.push(length, chunk)
  }
  parts.push(Buffer.alloc(4))
  return Buffer.concat(parts)
}

/** ClamAV's daemon over TCP. No answer, a timeout or an error is a failure, never "clean". */
export class ClamdScanner implements Scanner {
  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly timeoutMs = 30_000,
  ) {}

  scan(bytes: Buffer): Promise<ScanVerdict> {
    return new Promise((resolve, reject) => {
      const received: Buffer[] = []
      const socket = connect({ host: this.host, port: this.port })
      socket.setTimeout(this.timeoutMs, () => socket.destroy(new Error('clamd timed out')))
      socket.on('connect', () => socket.end(instreamOf(bytes)))
      socket.on('data', (data: Buffer) => received.push(data))
      socket.on('error', reject)
      socket.on('close', (failed) => {
        if (failed) return
        try {
          resolve(verdictOf(Buffer.concat(received).toString('utf8')))
        } catch (error) {
          reject(error)
        }
      })
    })
  }
}
