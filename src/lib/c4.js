import path from 'node:path';
import { execFile } from 'node:child_process';
import { parseC4Response } from './format.js';

export const DEFAULT_C4_RECEIVE = path.join(
  process.env.HOME || '',
  'zylos/.claude/skills/comm-bridge/scripts/c4-receive.js'
);

export function createC4Sender({
  c4Receive = DEFAULT_C4_RECEIVE,
  execFileImpl = execFile,
  retryDelayMs = 2000,
  logger = console,
} = {}) {
  return function sendToC4(source, endpoint, content, callbacks = {}) {
    const { onReject, onFail } = typeof callbacks === 'function'
      ? { onReject: callbacks }
      : callbacks;

    if (!content) {
      logger.error('[ms-teams] sendToC4 called with empty content');
      return;
    }

    const args = [
      c4Receive,
      '--channel', source,
      '--endpoint', endpoint,
      '--json',
      '--content', content
    ];

    execFileImpl('node', args, { encoding: 'utf8', timeout: 35000 }, (error, stdout) => {
      if (!error) {
        logger.log(`[ms-teams] Sent to C4: ${content.substring(0, 50)}...`);
        return;
      }

      const response = parseC4Response(error.stdout || stdout);
      if (response && response.ok === false && response.error?.message) {
        logger.warn(`[ms-teams] C4 rejected (${response.error.code}): ${response.error.message}`);
        if (onReject) onReject(response.error.message);
        return;
      }

      logger.warn(`[ms-teams] C4 send failed, retrying in 2s: ${error.message}`);
      setTimeout(() => {
        execFileImpl('node', args, { encoding: 'utf8', timeout: 35000 }, (retryError, retryStdout) => {
          if (!retryError) {
            logger.log(`[ms-teams] Sent to C4 (retry): ${content.substring(0, 50)}...`);
            return;
          }

          const retryResponse = parseC4Response(retryError.stdout || retryStdout);
          if (retryResponse && retryResponse.ok === false && retryResponse.error?.message) {
            logger.error(`[ms-teams] C4 rejected after retry (${retryResponse.error.code}): ${retryResponse.error.message}`);
            if (onReject) onReject(retryResponse.error.message);
          } else {
            logger.error(`[ms-teams] C4 send failed after retry: ${retryError.message}`);
            if (onFail) onFail();
          }
        });
      }, retryDelayMs);
    });
  };
}

export const sendToC4 = createC4Sender();
