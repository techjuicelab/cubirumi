#!/usr/bin/env node
import { runLifecycleHook } from '../integrations/claude-plugin/scripts/adapter-core.mjs';
await runLifecycleHook('codex');
