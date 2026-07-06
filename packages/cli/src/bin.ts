#!/usr/bin/env node
import { productionCliDeps, runCli } from './cli.js';

// `terminull` entry point — enroll / machines status / enroll --remove (M8).
// Further command wiring (session control, adapter selection) lands in M10.
const code = await runCli(process.argv.slice(2), productionCliDeps());
process.exit(code);
