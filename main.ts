// Pump.fun Paper Sprint — deep-dip paper bot.
//
// Run by the grader as `node main.ts` (Node 22 strips the types; no build,
// no install, stdlib only). The SDK shim is vendored byte for byte at
// vendor/makefun-bot.ts (sha256 4e243d4a0adce99b66b6124dd5a9c06867a92f7a0dd03dc6d65195f2f9ebbf08,
// the kit's sdk/ts/makefun-bot.ts). See STRATEGY.md for the rules.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
