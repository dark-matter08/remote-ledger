// Types for win.mjs, which is plain JavaScript because it is imported by the CLI
// scripts, which run under node with no build step.
export declare const isWindows: boolean;
export declare function quoteArg(value: unknown): string;
export declare function winSafe(cmd: string, args: string[], win?: boolean): [string, string[]];
