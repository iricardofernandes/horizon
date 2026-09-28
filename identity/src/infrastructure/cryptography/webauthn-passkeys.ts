import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server'
import { type PasskeyCredential, Passkeys } from '@/application/ports/mfa'

type RegistrationResponse = Parameters<typeof verifyRegistrationResponse>[0]['response']
type AuthenticationResponse = Parameters<typeof verifyAuthenticationResponse>[0]['response']

/** WebAuthn through @simplewebauthn/server: the relying party is the web's host (ADR 0061). */
export class WebAuthnPasskeys extends Passkeys {
  constructor(
    private readonly rpId: string,
    private readonly origin: string,
    private readonly rpName = 'Horizon',
  ) {
    super()
  }

  async registrationOptions(input: {
    accountId: string
    userName: string
    exclude: readonly PasskeyCredential[]
  }) {
    const options = await generateRegistrationOptions({
      rpName: this.rpName,
      rpID: this.rpId,
      userName: input.userName,
      userID: new TextEncoder().encode(input.accountId),
      attestationType: 'none',
      excludeCredentials: input.exclude.map((credential) => ({
        id: credential.id,
        transports: [...credential.transports],
      })),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
    })
    return { options, challenge: options.challenge }
  }

  async verifyRegistration(response: unknown, challenge: string) {
    const verified = await verifyRegistrationResponse({
      response: response as RegistrationResponse,
      expectedChallenge: challenge,
      expectedOrigin: this.origin,
      expectedRPID: this.rpId,
      requireUserVerification: false,
    })
    if (!verified.verified) return null
    const { credential } = verified.registrationInfo
    return {
      id: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString('base64url'),
      signCount: credential.counter,
      transports: credential.transports ?? [],
    }
  }

  async authenticationOptions(allow: readonly PasskeyCredential[]) {
    const options = await generateAuthenticationOptions({
      rpID: this.rpId,
      allowCredentials: allow.map((credential) => ({
        id: credential.id,
        transports: [...credential.transports],
      })),
      userVerification: 'preferred',
    })
    return { options, challenge: options.challenge }
  }

  async verifyAuthentication(
    response: unknown,
    challenge: string,
    credentials: readonly PasskeyCredential[],
  ) {
    const presented = response as AuthenticationResponse
    const credential = credentials.find((candidate) => candidate.id === presented?.id)
    if (!credential) return null
    const verified = await verifyAuthenticationResponse({
      response: presented,
      expectedChallenge: challenge,
      expectedOrigin: this.origin,
      expectedRPID: this.rpId,
      credential: {
        id: credential.id,
        publicKey: new Uint8Array(Buffer.from(credential.publicKey, 'base64url')),
        counter: credential.signCount,
        transports: [...credential.transports] as never,
      },
      requireUserVerification: false,
    })
    return verified.verified
      ? { id: credential.id, signCount: verified.authenticationInfo.newCounter }
      : null
  }
}
