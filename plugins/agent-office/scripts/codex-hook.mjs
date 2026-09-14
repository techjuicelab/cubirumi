#!/usr/bin/env node
import { runLifecycleHook } from './adapter-core.mjs';
await runLifecycleHook('codex');
