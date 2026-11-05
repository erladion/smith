// Replaced with the release version when the binary is built (scripts/build-binary.mjs).
declare const __AGENT_VERSION__: string | undefined;

export const VERSION = typeof __AGENT_VERSION__ === "string" ? __AGENT_VERSION__ : "dev";
