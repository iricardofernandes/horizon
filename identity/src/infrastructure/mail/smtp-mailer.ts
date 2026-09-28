import { createTransport, type Transporter } from 'nodemailer'
import { Mailer, type MailMessage } from '@/application/ports/mfa'

/** SMTP: Mailpit in the local stack, a relay in production (ADR 0061). */
export class SmtpMailer extends Mailer {
  private readonly transport: Transporter

  constructor(
    url: string,
    private readonly from: string,
  ) {
    super()
    const endpoint = new URL(url)
    this.transport = createTransport({
      host: endpoint.hostname,
      port: Number(endpoint.port || 25),
      secure: endpoint.protocol === 'smtps:',
      ...(endpoint.username
        ? {
            auth: {
              user: decodeURIComponent(endpoint.username),
              pass: decodeURIComponent(endpoint.password),
            },
          }
        : {}),
      connectionTimeout: 5000,
      socketTimeout: 10_000,
    })
  }

  async send(message: MailMessage): Promise<void> {
    await this.transport.sendMail({
      from: this.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
    })
  }
}

/** Keeps what it would have sent, for tests and a stack without mail. */
export class MemoryMailer extends Mailer {
  readonly sent: MailMessage[] = []
  failing = false

  async send(message: MailMessage): Promise<void> {
    if (this.failing) throw new Error('Mail is down')
    this.sent.push(message)
  }
}
