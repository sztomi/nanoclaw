/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execSync } from 'child_process';
import os from 'os';

import { logger } from './logger.js';

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'docker';

/**
 * Detect whether `docker` is actually rootless Podman in compat mode.
 * Cached because it never changes during a process lifetime.
 *
 * Podman's Go info struct exposes `.Host.Security.Rootless` (a bool that
 * stringifies to "true"/"false"). Real Docker's info struct has no such
 * field — the template fails and our catch block returns false.
 */
let cachedRootlessPodman: boolean | null = null;
export function isRootlessPodman(): boolean {
  if (cachedRootlessPodman !== null) return cachedRootlessPodman;
  try {
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} info --format '{{.Host.Security.Rootless}}'`,
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf-8',
        timeout: 5000,
      },
    );
    cachedRootlessPodman = output.trim() === 'true';
    if (cachedRootlessPodman) {
      logger.info('Detected rootless Podman in docker-compat mode');
    }
  } catch {
    cachedRootlessPodman = false;
  }
  return cachedRootlessPodman;
}

/**
 * Extra CLI args for user-namespace handling.
 *
 * Rootless Podman maps the host user (uid 1000) to container uid 0 by default,
 * which means files written by the host don't match the container's `node` user
 * (uid 1000 inside the container → some subuid on the host). The result is
 * EACCES on unlink when the container tries to consume IPC input files.
 *
 * `--userns=keep-id` tells Podman to map the host uid back to the same uid
 * inside the container, so host uid 1000 == container uid 1000 == container's
 * `node` user, and bind-mounted files are owned by the right user inside.
 *
 * Real Docker doesn't need this (its default rootful userns has no mapping),
 * and `--userns=keep-id` is Podman-specific so we only emit it for Podman.
 */
export function userNamespaceArgs(): string[] {
  return isRootlessPodman() ? ['--userns=keep-id'] : [];
}

/** CLI args needed for the container to resolve the host gateway. */
export function hostGatewayArgs(): string[] {
  // On Linux, host.docker.internal isn't built-in — add it explicitly
  if (os.platform() === 'linux') {
    return ['--add-host=host.docker.internal:host-gateway'];
  }
  return [];
}

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(
  hostPath: string,
  containerPath: string,
): string[] {
  return ['-v', `${hostPath}:${containerPath}:ro`];
}

/** Stop a container by name. Uses execFileSync to avoid shell injection. */
export function stopContainer(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    throw new Error(`Invalid container name: ${name}`);
  }
  execSync(`${CONTAINER_RUNTIME_BIN} stop -t 1 ${name}`, { stdio: 'pipe' });
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    logger.debug('Container runtime already running');
  } catch (err) {
    logger.error({ err }, 'Failed to reach container runtime');
    console.error(
      '\n╔════════════════════════════════════════════════════════════════╗',
    );
    console.error(
      '║  FATAL: Container runtime failed to start                      ║',
    );
    console.error(
      '║                                                                ║',
    );
    console.error(
      '║  Agents cannot run without a container runtime. To fix:        ║',
    );
    console.error(
      '║  1. Ensure Docker is installed and running                     ║',
    );
    console.error(
      '║  2. Run: docker info                                           ║',
    );
    console.error(
      '║  3. Restart NanoClaw                                           ║',
    );
    console.error(
      '╚════════════════════════════════════════════════════════════════╝\n',
    );
    throw new Error('Container runtime is required but failed to start', {
      cause: err,
    });
  }
}

/** Kill orphaned NanoClaw containers from previous runs. */
export function cleanupOrphans(): void {
  try {
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} ps --filter name=nanoclaw- --format '{{.Names}}'`,
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
    );
    const orphans = output.trim().split('\n').filter(Boolean);
    for (const name of orphans) {
      try {
        stopContainer(name);
      } catch {
        /* already stopped */
      }
    }
    if (orphans.length > 0) {
      logger.info(
        { count: orphans.length, names: orphans },
        'Stopped orphaned containers',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}
