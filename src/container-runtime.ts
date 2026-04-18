/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';

import { logger } from './logger.js';

/** The container runtime binary name. Defaults: docker on Linux, container on macOS. Overridable via CONTAINER_RUNTIME env var. */
export const CONTAINER_RUNTIME_BIN =
  process.env.CONTAINER_RUNTIME ||
  (os.platform() === 'linux' ? 'docker' : 'container');

/**
 * Hostname/IP containers use to reach the host machine.
 * - Docker (Linux): host.docker.internal, added to /etc/hosts via hostGatewayArgs.
 * - Apple Container (macOS): bridge network gateway (192.168.64.x).
 */
export const CONTAINER_HOST_GATEWAY = detectHostGateway();

function detectHostGateway(): string {
  if (os.platform() === 'linux') {
    // Docker containers reach the host via host.docker.internal (added via
    // --add-host=host.docker.internal:host-gateway in hostGatewayArgs).
    return 'host.docker.internal';
  }
  // Apple Container on macOS: containers reach the host via the bridge network gateway
  const ifaces = os.networkInterfaces();
  const bridge = ifaces['bridge100'] || ifaces['bridge0'];
  if (bridge) {
    const ipv4 = bridge.find((a) => a.family === 'IPv4');
    if (ipv4) return ipv4.address;
  }
  // Fallback: Apple Container's default gateway
  return '192.168.64.1';
}

/**
 * Address the credential proxy binds to.
 * Must be set via CREDENTIAL_PROXY_HOST in .env — there is no safe default
 * for Apple Container because bridge100 only exists while containers run,
 * but the proxy must start before any container.
 * The /convert-to-apple-container skill sets this during setup.
 */
export const PROXY_BIND_HOST = process.env.CREDENTIAL_PROXY_HOST;
if (!PROXY_BIND_HOST) {
  throw new Error(
    'CREDENTIAL_PROXY_HOST is not set in .env. Run /convert-to-apple-container to configure.',
  );
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
  return [
    '--mount',
    `type=bind,source=${hostPath},target=${containerPath},readonly`,
  ];
}

/** Stop a container by name. Uses execFileSync to avoid shell injection. */
export function stopContainer(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    throw new Error(`Invalid container name: ${name}`);
  }
  execSync(`${CONTAINER_RUNTIME_BIN} stop ${name}`, { stdio: 'pipe' });
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  const isDocker = CONTAINER_RUNTIME_BIN === 'docker';
  const statusCmd = isDocker
    ? `${CONTAINER_RUNTIME_BIN} info`
    : `${CONTAINER_RUNTIME_BIN} system status`;
  try {
    execSync(statusCmd, { stdio: 'pipe' });
    logger.debug('Container runtime already running');
  } catch {
    if (isDocker) {
      logger.error(
        'Docker daemon not reachable — ensure docker.service is running',
      );
      throw new Error(
        'Docker daemon not running. Run: sudo systemctl start docker',
      );
    }
    logger.info('Starting container runtime...');
    try {
      execSync(`${CONTAINER_RUNTIME_BIN} system start`, {
        stdio: 'pipe',
        timeout: 30000,
      });
      logger.info('Container runtime started');
    } catch (err) {
      logger.error({ err }, 'Failed to start container runtime');
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
        '║  1. Ensure Apple Container is installed                        ║',
      );
      console.error(
        '║  2. Run: container system start                                ║',
      );
      console.error(
        '║  3. Restart NanoClaw                                           ║',
      );
      console.error(
        '╚════════════════════════════════════════════════════════════════╝\n',
      );
      throw new Error('Container runtime is required but failed to start');
    }
  }
}

/** Kill orphaned NanoClaw containers from previous runs. */
export function cleanupOrphans(): void {
  const isDocker = CONTAINER_RUNTIME_BIN === 'docker';
  try {
    let orphans: string[];
    if (isDocker) {
      // Docker: list running container names matching nanoclaw- prefix
      const output = execSync(
        `${CONTAINER_RUNTIME_BIN} ps --filter name=nanoclaw- --format {{.Names}}`,
        { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
      );
      orphans = output.split('\n').filter((n) => n.startsWith('nanoclaw-'));
    } else {
      // Apple Container: ls --format json
      const output = execSync(`${CONTAINER_RUNTIME_BIN} ls --format json`, {
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf-8',
      });
      const containers: { status: string; configuration: { id: string } }[] =
        JSON.parse(output || '[]');
      orphans = containers
        .filter(
          (c) =>
            c.status === 'running' &&
            c.configuration.id.startsWith('nanoclaw-'),
        )
        .map((c) => c.configuration.id);
    }
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
