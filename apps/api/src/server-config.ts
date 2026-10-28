/** Railway and other platforms provide PORT; local development is deliberately stable. */
export function resolveServerPort(port: string | undefined): number {
  return port ? Number(port) : 4000;
}

export function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
}
