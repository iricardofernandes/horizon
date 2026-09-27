import { uuidv7 } from 'uuidv7'

export class UniqueEntityID {
  private readonly value: string
  constructor(value?: string) {
    this.value = value ?? uuidv7()
  }
  toString(): string {
    return this.value
  }
  toValue(): string {
    return this.value
  }
  equals(other: UniqueEntityID): boolean {
    return this.value === other.toValue()
  }
}
