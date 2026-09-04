// Ported from OpenAI Codex apply-patch (Apache-2.0); see THIRD_PARTY_NOTICES.md.
type LineEnding = '\n' | '\r\n' | '\r'

interface SourceLine {
  text: string
  ending?: LineEnding
}

export type Replacement = readonly [startIndex: number, oldLength: number, newLines: readonly string[]]

/** TypeScript port of Codex apply-patch's PreserveLineEndings SourceFile. */
export class SourceFile {
  private lines: SourceLine[]
  private readonly preferredEnding: LineEnding

  private constructor(lines: SourceLine[], preferredEnding: LineEnding) {
    this.lines = lines
    this.preferredEnding = preferredEnding
  }

  static parse(content: string): SourceFile {
    const lines: SourceLine[] = []
    let preferredEnding: LineEnding | undefined
    let lineStart = 0
    let cursor = 0
    while (cursor < content.length) {
      const current = content[cursor]
      let ending: LineEnding | undefined
      let endingLength = 0
      if (current === '\r' && content[cursor + 1] === '\n') {
        ending = '\r\n'
        endingLength = 2
      } else if (current === '\r' || current === '\n') {
        ending = current
        endingLength = 1
      }
      if (ending === undefined) {
        cursor += 1
        continue
      }
      preferredEnding ??= ending
      lines.push({ text: content.slice(lineStart, cursor), ending })
      cursor += endingLength
      lineStart = cursor
    }
    if (lineStart < content.length) lines.push({ text: content.slice(lineStart) })
    return new SourceFile(lines, preferredEnding ?? '\n')
  }

  lineTexts(): string[] {
    return this.lines.map(line => line.text)
  }

  applyReplacements(replacements: readonly Replacement[]): void {
    const result: SourceLine[] = []
    let sourceIndex = 0
    for (const [start, oldLength, newLines] of replacements) {
      if (start < sourceIndex) throw new Error('overlapping replacements')
      result.push(...this.lines.slice(sourceIndex, start))
      result.push(...newLines.map(text => ({ text, ending: this.preferredEnding })))
      sourceIndex = start + oldLength
    }
    result.push(...this.lines.slice(sourceIndex))

    // Codex updates historically leave every resulting line terminated.
    for (const line of result) line.ending ??= this.preferredEnding
    this.lines = result
  }

  contents(): string {
    return this.lines.map(line => `${line.text}${line.ending ?? ''}`).join('')
  }
}
