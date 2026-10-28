/** Playwright disables extensions by default; remove only that default for this harness. */
export const extensionE2eIgnoreDefaultArgs = ["--disable-extensions"] as const;

export function extensionE2eLaunchArgs(extensionDirectory: string) {
  return [
    `--disable-extensions-except=${extensionDirectory}`,
    `--load-extension=${extensionDirectory}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
  ];
}
