import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';

// Read config values from .env (falls back to process.env).
// Secrets are NOT read here — they stay on disk and are loaded only
// where needed (container-runner.ts) to avoid leaking to child processes.
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_ONLY',
  'WEBSOCKET_ENABLED',
  'WEBSOCKET_PORT',
  'WEBSOCKET_FILES_PORT',
  'OLLAMA_HOST',
  'OLLAMA_TIMEOUT_MS',
  'EMBEDDING_MODEL',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Nano';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');
export const MAIN_GROUP_FOLDER = 'main';

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

// Telegram configuration
export const TELEGRAM_BOT_TOKEN =
  process.env.TELEGRAM_BOT_TOKEN || envConfig.TELEGRAM_BOT_TOKEN || '';
export const TELEGRAM_ONLY =
  (process.env.TELEGRAM_ONLY || envConfig.TELEGRAM_ONLY) === 'true';
export const TELEGRAM_BOT_POOL = (process.env.TELEGRAM_BOT_POOL || '')
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean);

export const WEBSOCKET_ENABLED =
  (process.env.WEBSOCKET_ENABLED ?? envConfig.WEBSOCKET_ENABLED ?? 'true') !== 'false';
export const WEBSOCKET_HOST =
  process.env.WEBSOCKET_HOST || envConfig.WEBSOCKET_HOST || '127.0.0.1';
export const WEBSOCKET_PORT = parseInt(
  process.env.WEBSOCKET_PORT || envConfig.WEBSOCKET_PORT || '3001',
  10,
);
export const WEBSOCKET_FILES_PORT = parseInt(
  process.env.WEBSOCKET_FILES_PORT || envConfig.WEBSOCKET_FILES_PORT || '3002',
  10,
);

// Memory loading budget (tokens allocated to loading prior context at startup)
// Adjust these values based on your agent's context window and needs
export const MEMORY_CONTEXT_BUDGET = parseInt(
  process.env.MEMORY_CONTEXT_BUDGET || '8000',
  10,
); // 8000 tokens default — ~32KB context

// Per-layer token allocation as percentage of total budget
// Layers load in priority order; unused allocation flows to next layer
export const MEMORY_LAYER_ALLOCATION = {
  tacit: 0.15, // 15% — behavior rules are non-negotiable
  daily: 0.35, // 35% — recent context is highly relevant
  conversation: 0.3, // 30% — continuity matters
  knowledge: 0.2, // 20% — permanent facts fill remaining space
};

// If remaining context budget after memory loading < this threshold,
// log a warning so operator knows memory is tight
export const LOW_MEMORY_BUDGET_WARNING_PERCENT = 0.3; // 30% of context window

// Embedding / semantic search configuration
// EMBEDDING_DIM must never change after the vec_embeddings table is created.
export const EMBEDDING_DIM = 768;
export const EMBEDDING_MODEL =
  process.env.EMBEDDING_MODEL || envConfig.EMBEDDING_MODEL || 'nomic-embed-text';
export const OLLAMA_HOST =
  process.env.OLLAMA_HOST || envConfig.OLLAMA_HOST || 'http://127.0.0.1:11434';
export const OLLAMA_TIMEOUT_MS = parseInt(
  process.env.OLLAMA_TIMEOUT_MS || envConfig.OLLAMA_TIMEOUT_MS || '10000',
  10,
);
