import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { signedSupplierInvoice, supplierCredential, withProtocol } from './nfe55/supplier-invoice'

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index < 0 ? undefined : process.argv[index + 1]
}

function flags(name: string): string[] {
  return process.argv.flatMap((argument, index) =>
    argument === `--${name}` && process.argv[index + 1] ? [process.argv[index + 1] as string] : [],
  )
}

const taxId = z.string().regex(/^[0-9A-Z]{12}[0-9]{2}$/)

/**
 * Writes a signed homologation-environment supplier NF-e for simulation drills. The
 * signing certificate is a throwaway self-signed A1 created for this run only.
 */
async function main(): Promise<void> {
  if (process.env.FISCAL_ALLOW_SUPPLIER_FIXTURE !== 'true')
    throw new Error('Supplier NF-e fixtures require FISCAL_ALLOW_SUPPLIER_FIXTURE=true')
  const supplierTaxId = taxId.parse(flag('supplier-tax-id'))
  const lines = flags('line').map((entry) => {
    const [productCode, ncm, quantity, unitPrice, description] = entry.split('|')
    return z
      .strictObject({
        productCode: z.string().min(1).max(60),
        ncm: z.string().regex(/^\d{8}$/),
        quantity: z.string().regex(/^\d+$/),
        unitPrice: z.string().regex(/^\d+\.\d{2}$/),
        description: z.string().min(1).max(120),
      })
      .parse({ productCode, ncm, quantity, unitPrice, description: description ?? productCode })
  })
  if (lines.length === 0) throw new Error('At least one --line code|ncm|quantity|price is required')
  const directory = await mkdtemp(join(tmpdir(), 'horizon-supplier-fixture-'))
  try {
    const credential = await supplierCredential(directory, supplierTaxId)
    const signed = signedSupplierInvoice(
      {
        supplierTaxId,
        recipientTaxId: taxId.parse(flag('recipient-tax-id')),
        number: z.coerce.number().int().min(1).max(999_999_999).parse(flag('number')),
        lines,
      },
      credential,
    )
    const out = z.string().min(1).parse(flag('out'))
    await writeFile(out, process.argv.includes('--protocol') ? withProtocol(signed) : signed)
    console.log(JSON.stringify({ out, accessKey: /Id="NFe(\w{44})"/.exec(signed.toString())?.[1] }))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Supplier NF-e fixture failed')
  process.exitCode = 1
})
