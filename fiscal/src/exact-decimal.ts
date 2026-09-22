export type Rational = Readonly<{ numerator: bigint; denominator: bigint }>

export function integer(value: bigint): Rational {
  return { numerator: value, denominator: 1n }
}

export function decimal(value: string): Rational {
  if (!/^-?(0|[1-9]\d*)(\.\d+)?$/.test(value)) throw new Error('Invalid canonical decimal')
  const negative = value.startsWith('-')
  const unsigned = negative ? value.slice(1) : value
  const [whole = '0', fraction = ''] = unsigned.split('.')
  const denominator = 10n ** BigInt(fraction.length)
  const numerator = BigInt(`${whole}${fraction}`) * (negative ? -1n : 1n)
  return reduce({ numerator, denominator })
}

export function multiply(left: Rational, right: Rational): Rational {
  return reduce({
    numerator: left.numerator * right.numerator,
    denominator: left.denominator * right.denominator,
  })
}

export function add(left: Rational, right: Rational): Rational {
  return reduce({
    numerator: left.numerator * right.denominator + right.numerator * left.denominator,
    denominator: left.denominator * right.denominator,
  })
}

export function roundHalfAwayFromZero(value: Rational): bigint {
  const sign = value.numerator < 0n ? -1n : 1n
  const absolute = value.numerator < 0n ? -value.numerator : value.numerator
  const quotient = absolute / value.denominator
  const remainder = absolute % value.denominator
  return sign * (quotient + (remainder * 2n >= value.denominator ? 1n : 0n))
}

export function reduce(value: Rational): Rational {
  if (value.denominator === 0n) throw new Error('A rational denominator cannot be zero')
  const sign = value.denominator < 0n ? -1n : 1n
  const divisor = greatestCommonDivisor(value.numerator, value.denominator)
  return {
    numerator: (value.numerator / divisor) * sign,
    denominator: (value.denominator / divisor) * sign,
  }
}

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left
  let b = right < 0n ? -right : right
  while (b !== 0n) [a, b] = [b, a % b]
  return a === 0n ? 1n : a
}
