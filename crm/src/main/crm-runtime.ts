import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { CrmModuleEventHandlers } from '@/application/consume-module-events'
import type { Clock } from '@/application/ports/clock'
import { UpdateAccountProfileUseCase } from '@/application/use-cases/manage-accounts'
import {
  RecordActivityUseCase,
  ReviseActivityUseCase,
} from '@/application/use-cases/manage-activities'
import {
  ChangeContactStatusUseCase,
  CreateContactUseCase,
  EraseContactUseCase,
  ReviseContactUseCase,
} from '@/application/use-cases/manage-contacts'
import { CorrectNoteUseCase, WriteNoteUseCase } from '@/application/use-cases/manage-notes'
import {
  ChangeOpportunityUseCase,
  CreateOpportunityUseCase,
} from '@/application/use-cases/manage-opportunities'
import {
  ChangeListEntryUseCase,
  ChangePipelineUseCase,
  CreateListEntryUseCase,
  CreatePipelineUseCase,
} from '@/application/use-cases/manage-pipelines'
import { ChangeTaskUseCase, CreateTaskUseCase } from '@/application/use-cases/manage-tasks'
import { AccessTokenVerifier } from '@/infrastructure/cryptography/access-token-verifier'
import { AesGcmSecretBox } from '@/infrastructure/cryptography/aes-gcm-secret-box'
import { CrmDatabase } from '@/infrastructure/database/drizzle/crm-database'
import type { CrmEnvironment } from './environment'

/** Explicit composition: every dependency is visible in one place. */
export class CrmRuntime implements OnModuleInit, OnModuleDestroy {
  readonly database: CrmDatabase
  readonly clock: Clock
  readonly accessTokens: AccessTokenVerifier
  readonly updateAccountProfile: UpdateAccountProfileUseCase
  readonly createContact: CreateContactUseCase
  readonly reviseContact: ReviseContactUseCase
  readonly changeContactStatus: ChangeContactStatusUseCase
  readonly eraseContact: EraseContactUseCase
  readonly createPipeline: CreatePipelineUseCase
  readonly changePipeline: ChangePipelineUseCase
  readonly createListEntry: CreateListEntryUseCase
  readonly changeListEntry: ChangeListEntryUseCase
  readonly createOpportunity: CreateOpportunityUseCase
  readonly changeOpportunity: ChangeOpportunityUseCase
  readonly recordActivity: RecordActivityUseCase
  readonly reviseActivity: ReviseActivityUseCase
  readonly createTask: CreateTaskUseCase
  readonly changeTask: ChangeTaskUseCase
  readonly writeNote: WriteNoteUseCase
  readonly correctNote: CorrectNoteUseCase
  readonly eventHandlers: CrmModuleEventHandlers

  constructor(config: CrmEnvironment) {
    const clock = { now: () => new Date() }
    this.clock = clock
    this.database = new CrmDatabase({
      url: config.DATABASE_URL,
      poolMax: config.DATABASE_POOL_MAX,
      statementTimeoutMs: config.DATABASE_STATEMENT_TIMEOUT_MS,
      secretBox: new AesGcmSecretBox(),
    })
    this.accessTokens = new AccessTokenVerifier(
      config.JWKS_URL,
      config.ACCESS_TOKEN_MAX_AGE_SECONDS,
    )
    this.updateAccountProfile = new UpdateAccountProfileUseCase(this.database, clock)
    this.createContact = new CreateContactUseCase(this.database, clock)
    this.reviseContact = new ReviseContactUseCase(this.database, clock)
    this.changeContactStatus = new ChangeContactStatusUseCase(this.database, clock)
    this.eraseContact = new EraseContactUseCase(this.database, clock)
    this.createPipeline = new CreatePipelineUseCase(this.database, clock)
    this.changePipeline = new ChangePipelineUseCase(this.database, clock)
    this.createListEntry = new CreateListEntryUseCase(this.database, clock)
    this.changeListEntry = new ChangeListEntryUseCase(this.database, clock)
    this.createOpportunity = new CreateOpportunityUseCase(this.database, clock)
    this.changeOpportunity = new ChangeOpportunityUseCase(this.database, clock)
    this.recordActivity = new RecordActivityUseCase(this.database, clock)
    this.reviseActivity = new ReviseActivityUseCase(this.database, clock)
    this.createTask = new CreateTaskUseCase(this.database, clock)
    this.changeTask = new ChangeTaskUseCase(this.database, clock)
    this.writeNote = new WriteNoteUseCase(this.database, clock)
    this.correctNote = new CorrectNoteUseCase(this.database, clock)
    this.eventHandlers = new CrmModuleEventHandlers(this.database, clock)
  }

  onModuleInit(): Promise<void> {
    return this.database.ping()
  }

  onModuleDestroy(): Promise<void> {
    return this.database.close()
  }
}
