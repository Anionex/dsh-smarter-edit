// Rust char::is_whitespace set used by the pinned Codex parser and matcher.
const RUST_WHITESPACE = /[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/u

function isRustWhitespace(character: string | undefined): boolean {
  return character !== undefined && RUST_WHITESPACE.test(character)
}

export function rustTrimStart(value: string): string {
  let start = 0
  while (start < value.length && isRustWhitespace(value[start])) start += 1
  return value.slice(start)
}

export function rustTrimEnd(value: string): string {
  let end = value.length
  while (end > 0 && isRustWhitespace(value[end - 1])) end -= 1
  return value.slice(0, end)
}

export function rustTrim(value: string): string {
  return rustTrimEnd(rustTrimStart(value))
}
