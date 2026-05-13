#!/usr/bin/env node
/**
 * Pre-upgrade hook for zylos-msteams
 *
 * Called by Claude BEFORE CLI upgrade steps.
 * If this hook fails (exit code 1), the upgrade is aborted.
 *
 * This hook handles:
 * - Backup critical data before upgrade
 *
 * Exit codes:
 *   0 - Continue with upgrade
 *   1 - Abort upgrade (with error message)
 */

import fs from 'fs';
import path from 'path';

const HOME = process.env.HOME;
const DATA_DIR = path.join(HOME, 'zylos/components/msteams');
const configPath = path.join(DATA_DIR, 'config.json');

console.log('[pre-upgrade] Running msteams pre-upgrade checks...\n');

// 1. Backup config before upgrade
if (fs.existsSync(configPath)) {
  const backupPath = configPath + '.backup';
  fs.copyFileSync(configPath, backupPath);
  console.log('Config backed up to:', backupPath);
}

console.log('\n[pre-upgrade] Checks passed, proceeding with upgrade.');
