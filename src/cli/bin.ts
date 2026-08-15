#!/usr/bin/env node
/**
 * `continuum` bin entrypoint. Compiled to `dist/cli/bin.js` and referenced
 * by package.json's `bin`. The `node` shebang makes it directly executable
 * once `tsc` emits it.
 */

import { main } from "./index.js";

main(process.argv)
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    // Never log a secret: the error path prints only the message, and our
    // own error types already strip secret values before construction.
    process.stderr.write(`continuum: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
