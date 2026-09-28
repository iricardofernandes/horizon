import { IMPORT_MAX_BYTES, IMPORT_MAX_ROWS } from '@horizon/contracts'
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { ImportJobs } from '@/application/imports/imports'
import { PartyImporter } from '@/application/imports/party-importer'
import {
  ChangePartyRoleUseCase,
  ChangePartyStatusUseCase,
  DescribePartyFiscalProfileUseCase,
  DescribePartyUseCase,
  ErasePartyUseCase,
  FindLookalikePartiesUseCase,
  IdentifyPartyUseCase,
  RegisterPartyUseCase,
} from '@/application/use-cases/manage-parties'
import { AccessTokenVerifier } from '@/infrastructure/cryptography/access-token-verifier'
import { AesGcmSecretBox } from '@/infrastructure/cryptography/aes-gcm-secret-box'
import { SqlImportStore } from '@/infrastructure/database/drizzle/import-store'
import { PartiesDatabase } from '@/infrastructure/database/drizzle/parties-database'
import { RowWritingUnitOfWork, SealedImportRows } from '@/infrastructure/imports/party-rows'
import { TabularImportFiles } from '@/infrastructure/imports/tabular-files'
import type { PartiesEnvironment } from './environment'

/** Explicit composition: every dependency is visible in one place. */
export class PartiesRuntime implements OnModuleInit, OnModuleDestroy {
  readonly database: PartiesDatabase
  readonly accessTokens: AccessTokenVerifier
  readonly registerParty: RegisterPartyUseCase
  readonly describeParty: DescribePartyUseCase
  readonly describeFiscalProfile: DescribePartyFiscalProfileUseCase
  readonly changeRole: ChangePartyRoleUseCase
  readonly changeStatus: ChangePartyStatusUseCase
  readonly eraseParty: ErasePartyUseCase
  readonly identifyParty: IdentifyPartyUseCase
  readonly findLookalikes: FindLookalikePartiesUseCase
  readonly imports: ImportJobs

  constructor(config: PartiesEnvironment) {
    const clock = { now: () => new Date() }
    const secretBox = new AesGcmSecretBox()
    this.database = new PartiesDatabase({
      url: config.DATABASE_URL,
      poolMax: config.DATABASE_POOL_MAX,
      statementTimeoutMs: config.DATABASE_STATEMENT_TIMEOUT_MS,
      privacy: {
        secretBox,
        blindIndexKey: Buffer.from(config.PARTY_BLIND_INDEX_KEY, 'hex'),
      },
    })
    this.accessTokens = new AccessTokenVerifier(
      config.JWKS_URL,
      config.ACCESS_TOKEN_MAX_AGE_SECONDS,
    )
    this.registerParty = new RegisterPartyUseCase(this.database, clock)
    this.describeParty = new DescribePartyUseCase(this.database, clock)
    this.describeFiscalProfile = new DescribePartyFiscalProfileUseCase(this.database, clock)
    this.changeRole = new ChangePartyRoleUseCase(this.database, clock)
    this.changeStatus = new ChangePartyStatusUseCase(this.database, clock)
    this.eraseParty = new ErasePartyUseCase(this.database, clock)
    this.identifyParty = new IdentifyPartyUseCase(this.database, clock)
    this.findLookalikes = new FindLookalikePartiesUseCase(this.database)
    const database = this.database
    this.imports = new ImportJobs(
      new SqlImportStore(database, new SealedImportRows(secretBox), 'parties'),
      new TabularImportFiles(),
      [new PartyImporter(clock, (key) => new RowWritingUnitOfWork(database, key))],
      clock,
      {
        maxRows: IMPORT_MAX_ROWS,
        maxBytes: IMPORT_MAX_BYTES,
        batchSize: config.IMPORT_BATCH_SIZE,
        leaseMs: config.IMPORT_LEASE_MS,
        retentionMs: config.IMPORT_RETENTION_HOURS * 3_600_000,
      },
    )
  }

  onModuleInit(): Promise<void> {
    return this.database.ping()
  }

  onModuleDestroy(): Promise<void> {
    return this.database.close()
  }
}
