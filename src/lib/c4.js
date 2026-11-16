import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { parseC4Response } from './format.js';
import { sessionGroupFromEndpoint } from './session-group.js';

export const DEFAULT_C4_RECEIVE = path.join(
  process.env.HOME || '',
  'zylos/.claude/skills/comm-bridge/scripts/c4-receive.js'
);

export const GENERIC_REJECT_REPLY = "Sorry, I couldn't take this message right now. Please try again later.";
export const UNCERTAIN_REPLY = "Sorry, this message may not have reached me. If you don't get a reply in a few minutes, please send it again.";

/**
 * Whether the installed Core's c4-receive accepts an option. Read from
 * c4-receive-options.json next to c4-receive.js on every call; a missing or
 * unreadable manifest means "not supported" (older Core), never a version check.
 */
export function c4ReceiveSupportsOption(name, c4Receive = DEFAULT_C4_RECEIVE) {
  try {
    const manifest = JSON.parse(fs.readFileSync(
      path.join(path.dirname(c4Receive), 'c4-receive-options.json'), 'utf8'));
    return manifest !== null && typeof manifest === 'object' && !Array.isArray(manifest)
      && manifest.options !== null && typeof manifest.options === 'object'
      && !Array.isArray(manifest.options) && Object.hasOwn(manifest.options, name);
  } catch {
    return false;
  }
}

export function buildC4ReceiveArgs({ source, endpoint, content, sessionGroup, c4Receive = DEFAULT_C4_RECEIVE }) {
  const args = ['--channel', source, '--endpoint', endpoint, '--json', '--content', content];
  if (sessionGroup != null && sessionGroup !== '' && c4ReceiveSupportsOption('--session-group', c4Receive)) {
    args.push('--session-group', sessionGroup);
  }
  return args;
}

/**
 * Classify a structured c4-receive rejection by error.persisted:
 * non-empty array = Core committed the inbound row (send nothing, do not resend);
 * empty array = nothing stored; anything else = Core cannot tell.
 * @returns {'committed'|'not_stored'|'uncertain'}
 */
export function classifyC4Rejection(response) {
  const persisted = response?.error?.persisted;
  if (!Array.isArray(persisted)) return 'uncertain';
  return persisted.length > 0 ? 'committed' : 'not_stored';
}

/**
 * True only when the child process could not be started at all (so Core
 * never saw the message). Mirrors zylos-telegram v0.6.0 (#80).
 */
export function isSpawnFailure(error) {
  return typeof error?.syscall === 'string' && error.syscall.startsWith('spawn');
}

/**
 * Create the inbound sender. The session group is derived from the endpoint
 * and passed only when the installed Core lists --session-group (rechecked on
 * every attempt). A rejected group is never dropped and resent to the overall
 * group, and Core's error text (written for the agent) only goes to the log.
 * No component-side timeout kills c4-receive: killing it after Core stored the
 * row and retrying would deliver the message twice.
 *
 * Callbacks: onReject(notice) when the agent will not answer — a user-facing
 * notice, or null when Core already committed the row (send nothing);
 * onFail() when the outcome is uncertain (no structured answer and not a
 * spawn failure), or a spawn failure persisted after one retry.
 */
export function createC4Sender({
  c4Receive = DEFAULT_C4_RECEIVE,
  execFileImpl = execFile,
  retryDelayMs = 2000,
  logger = console,
  resolveGroup = (endpoint) => sessionGroupFromEndpoint(endpoint, { create: true }),
} = {}) {
  return function sendToC4(source, endpoint, content, callbacks = {}) {
    const { onReject, onFail } = typeof callbacks === 'function'
      ? { onReject: callbacks }
      : callbacks;

    if (!content) {
      logger.error('[ms-teams] sendToC4 called with empty content');
      return;
    }

    // Resolve (and possibly assign/store) a group only when Core accepts it;
    // older Core has a single session and needs no mapping.
    let sessionGroup;
    try {
      if (c4ReceiveSupportsOption('--session-group', c4Receive)) sessionGroup = resolveGroup(endpoint);
    } catch (err) {
      // Never fall back to the overall group.
      logger.error(`[ms-teams] cannot derive session group, not sending: ${err.message}`);
      if (onReject) onReject(GENERIC_REJECT_REPLY);
      return;
    }

    const run = (cb) => execFileImpl('node',
      [c4Receive, ...buildC4ReceiveArgs({ source, endpoint, content, sessionGroup, c4Receive })],
      { encoding: 'utf8' }, cb);

    const handleRejection = (response, label) => {
      const { code, message } = response.error;
      const kind = classifyC4Rejection(response);
      if (kind === 'committed') {
        logger.warn(`[ms-teams] C4 ${label} after commit (${code}), not resending: ${message}`);
        if (onReject) onReject(null);
        return;
      }
      logger.warn(`[ms-teams] C4 ${label} (${code}, ${kind}) [group=${sessionGroup}]: ${message}`);
      if (onReject) onReject(kind === 'not_stored' ? GENERIC_REJECT_REPLY : UNCERTAIN_REPLY);
    };

    run((error, stdout) => {
      if (!error) {
        logger.log(`[ms-teams] Sent to C4: ${content.substring(0, 50)}...`);
        return;
      }

      const response = parseC4Response(error.stdout || stdout);
      if (response && response.ok === false && response.error?.message) {
        handleRejection(response, 'rejected');
        return;
      }

      // Retry only when c4-receive provably never ran (spawn failure). Any
      // other unstructured failure may have stored the message already, and
      // Core forbids retrying an uncertain inbound call.
      if (!isSpawnFailure(error)) {
        logger.error(`[ms-teams] C4 send outcome uncertain, not retrying: ${error.message}`);
        if (onFail) onFail();
        return;
      }
      logger.warn(`[ms-teams] c4-receive could not start, retrying in ${retryDelayMs}ms: ${error.message}`);
      setTimeout(() => {
        run((retryError, retryStdout) => {
          if (!retryError) {
            logger.log(`[ms-teams] Sent to C4 (retry): ${content.substring(0, 50)}...`);
            return;
          }

          const retryResponse = parseC4Response(retryError.stdout || retryStdout);
          if (retryResponse && retryResponse.ok === false && retryResponse.error?.message) {
            handleRejection(retryResponse, 'rejected after retry');
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
