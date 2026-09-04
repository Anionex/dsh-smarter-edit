export type Replacement = readonly [startIndex: number, oldLength: number, newLines: readonly string[]];
/** TypeScript port of Codex apply-patch's PreserveLineEndings SourceFile. */
export declare class SourceFile {
    private lines;
    private readonly preferredEnding;
    private constructor();
    static parse(content: string): SourceFile;
    lineTexts(): string[];
    applyReplacements(replacements: readonly Replacement[]): void;
    contents(): string;
}
