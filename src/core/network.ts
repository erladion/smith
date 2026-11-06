import http from "node:http";
import tls from "node:tls";

/**
 * Makes connections to the model server behave like curl on the same
 * machine:
 *
 * - Trust the system certificate store too (on RHEL, what update-ca-trust
 *   manages), not only the CAs built into the runtime, so servers signed by
 *   an internal CA work.
 * - Use HTTPS_PROXY / HTTP_PROXY / NO_PROXY from the environment.
 *
 * Both are applied at run time where the runtime supports it. The binaries
 * also get the matching startup flags (see scripts/), which covers runtimes
 * where these functions are missing, e.g. the proxy setting on Node 22.
 */
export function useSystemNetworkSettings(): void {
  try {
    if (typeof tls.getCACertificates === "function" && typeof tls.setDefaultCACertificates === "function") {
      const certs = new Set([...tls.getCACertificates("default"), ...tls.getCACertificates("system")]);
      tls.setDefaultCACertificates([...certs]);
    }
  } catch {
    // Unsupported, or the system store can't be read: keep the built-in CAs.
  }
  try {
    const setProxy = (http as { setGlobalProxyFromEnv?: () => void }).setGlobalProxyFromEnv;
    if (typeof setProxy === "function") setProxy();
  } catch {
    // Unsupported here; the --use-env-proxy startup flag covers the binaries.
  }
}
