# Application errors and HTTP problems

Source: `identity/src/core/either.ts`, `identity/src/core/errors/`, domain errors,
`identity/src/infrastructure/http/problem-details-filter.ts`, and `presenters.ts`.
Proof: application unit suites and HTTP e2e tests.

Use Either.left for expected domain failures and Either.right for successful values.
Throw programmer errors and infrastructure failures. Controllers validate wire input,
call the use case and unwrap its result; the global filter selects HTTP status and
formats `application/problem+json`. A new expected error needs a stable problem type,
a concise title and an explicit filter mapping.

Validation problems identify the JSON pointer without returning the request body.
Unexpected failures return a generic message and log only safe diagnostic metadata.
Never serialize an Error cause, database query or environment wholesale: these can
contain passwords, encrypted values or credentials. Presenters enumerate allowed
fields; password hashes, API-key secret hashes and subject keys never leave as JSON.

For another module, add its error classes and mappings rather than copying Identity's
business failure names. Keep protocol shape consistent. Test content type, status,
validation pointers, unauthorized and forbidden cases, and that unexpected errors do
not reveal their internal message. Persistence uniqueness conflicts still need an
expected conflict response when preliminary checks race.
