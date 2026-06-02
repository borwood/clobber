export function resolvePort(envValue: string | undefined, defaultPort: number): number {
  if (envValue === undefined || envValue === "") return defaultPort;
  const parsed = parseInt(envValue, 10);
  if (isNaN(parsed) || String(parsed) !== envValue || parsed < 1 || parsed > 65535) {
    throw new Error(`invalid port value: "${envValue}" — must be an integer between 1 and 65535`);
  }
  return parsed;
}
