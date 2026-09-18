export abstract class UseCaseError extends Error {
  abstract readonly type: string
  abstract readonly title: string
  protected constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}
