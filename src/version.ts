// Replaced with the release version when the binary is built (scripts/build-binary.mjs).
declare const __SMITH_VERSION__: string | undefined;

export const VERSION = typeof __SMITH_VERSION__ === "string" ? __SMITH_VERSION__ : "dev";
