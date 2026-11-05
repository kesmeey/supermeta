#!/usr/bin/env node
// Thin launcher. Node >= 22.18 strips TypeScript types natively,
// so no build step, no bundler, no runtime dependencies.
import { main } from "../src/cli.ts";

await main(process.argv.slice(2));
