#!/usr/bin/env node
import { CLI_PLACEHOLDER } from './index.js';

// Placeholder entry point for the `terminull` command. Real command wiring
// (session control, adapter selection, etc.) lands in a later milestone.
process.stdout.write(`${CLI_PLACEHOLDER.name} ${CLI_PLACEHOLDER.version} (pre-alpha)\n`);
