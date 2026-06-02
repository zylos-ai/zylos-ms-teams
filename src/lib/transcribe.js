import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';

const EXTERNAL_TRANSCRIBE = path.join(process.env.HOME || '', 'zylos/bin/transcribe');

function executableExists(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function commandExists(command) {
  try {
    execFileSync('which', [command], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function runCommand(command, args, timeout = 90_000) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout, encoding: 'utf8' }, (err, stdout) => {
      if (err) return reject(err);
      resolve((stdout || '').trim());
    });
  });
}

export function getTranscriptionProvider(mode = 'auto', env = process.env) {
  const normalized = String(mode || 'auto').trim().toLowerCase();
  if (normalized === 'disabled') return { available: false, provider: 'disabled' };

  if ((normalized === 'auto' || normalized === 'local') && executableExists(EXTERNAL_TRANSCRIBE)) {
    return { available: true, provider: 'external', command: EXTERNAL_TRANSCRIBE };
  }
  if ((normalized === 'auto' || normalized === 'local') && commandExists('whisper-cli')) {
    return { available: true, provider: 'whisper.cpp', command: 'whisper-cli' };
  }
  if ((normalized === 'auto' || normalized === 'local') && commandExists('whisper')) {
    return { available: true, provider: 'whisper.cpp', command: 'whisper' };
  }
  if ((normalized === 'auto' || normalized === 'api') && env.OPENAI_API_KEY) {
    return { available: true, provider: 'openai-api' };
  }
  return { available: false, provider: 'none' };
}

async function transcribeWithOpenAI(audioPath, apiKey) {
  const form = new FormData();
  const blob = new Blob([fs.readFileSync(audioPath)]);
  form.append('file', blob, path.basename(audioPath));
  form.append('model', 'whisper-1');

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`OpenAI transcription failed (${res.status}): ${await res.text()}`);
  const json = await res.json();
  return String(json.text || '').trim();
}

export async function transcribeAudio(audioPath, { mode = 'auto', env = process.env } = {}) {
  const provider = getTranscriptionProvider(mode, env);
  if (!provider.available) throw new Error('voice transcription unavailable');
  if (provider.provider === 'external') return runCommand(provider.command, [audioPath]);
  if (provider.provider === 'whisper.cpp') return runCommand(provider.command, [audioPath]);
  if (provider.provider === 'openai-api') return transcribeWithOpenAI(audioPath, env.OPENAI_API_KEY);
  throw new Error('voice transcription unavailable');
}
