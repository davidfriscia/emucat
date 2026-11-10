import { describe, expect, it } from 'vitest';
import {
  EXECUTION_ERROR_CODES,
  EXECUTION_MODE_UNAVAILABLE_REASONS,
  IMPLEMENTED_EXECUTION_MODES,
  agentMessageSchema,
  executionRecovery,
  isSessionActive,
  launchRequestSchema,
  serverMessageSchema,
  stopSessionRequestSchema,
  verifyRecovery,
} from '../src/index.js';
import { fixture } from './helpers.js';

const all = fixture<Record<string, unknown[]>>('wire-examples');

describe('execution messages', () => {
  it('accepts the shared examples, each in the right direction', () => {
    expect(all.executionServerMessages?.length).toBeGreaterThan(0);
    for (const example of all.executionServerMessages ?? []) {
      expect(serverMessageSchema.safeParse(example).success, JSON.stringify(example)).toBe(true);
      expect(agentMessageSchema.safeParse(example).success).toBe(false);
    }
    for (const example of all.executionAgentMessages ?? []) {
      expect(agentMessageSchema.safeParse(example).success, JSON.stringify(example)).toBe(true);
      expect(serverMessageSchema.safeParse(example).success).toBe(false);
    }
  });

  it('refuses a command that carries a command line, a path, a PID or a mode it does not know', () => {
    expect(all.executionRefusedByTheAgent?.length).toBeGreaterThan(0);
    for (const example of all.executionRefusedByTheAgent ?? []) {
      expect(serverMessageSchema.safeParse(example).success, JSON.stringify(example)).toBe(false);
    }
  });
});

describe('what an administrator can ask for', () => {
  const launch = {
    agentId: '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e6400',
    emulatorType: '86box',
    vmName: 'DOS622',
    mode: 'local',
    requestId: '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e6401',
  };

  it('names a VM, an agent and a mode, and nothing that could be run', () => {
    expect(launchRequestSchema.safeParse(launch).success).toBe(true);
    for (const extra of [
      { command: 'cmd.exe' },
      { executable: 'C:\\Windows\\System32\\cmd.exe' },
      { args: ['-monitor', 'stdio'] },
      { workingDirectory: 'C:\\' },
    ]) {
      expect(launchRequestSchema.safeParse({ ...launch, ...extra }).success).toBe(false);
    }
    expect(launchRequestSchema.safeParse({ ...launch, vmName: '..\\x' }).success).toBe(false);
    expect(launchRequestSchema.safeParse({ ...launch, requestId: undefined }).success).toBe(false);
  });

  it('needs a typed confirmation for a forced stop', () => {
    expect(stopSessionRequestSchema.safeParse({ force: false }).success).toBe(true);
    expect(stopSessionRequestSchema.safeParse({ force: true }).success).toBe(false);
    expect(stopSessionRequestSchema.safeParse({ force: true, confirmVmName: '' }).success).toBe(
      false,
    );
    expect(
      stopSessionRequestSchema.safeParse({ force: true, confirmVmName: 'DOS622' }).success,
    ).toBe(true);
    expect(stopSessionRequestSchema.safeParse({ force: false, pid: 4 }).success).toBe(false);
  });
});

describe('sessions', () => {
  it('treats every state in which an emulator may run as active', () => {
    for (const state of ['requested', 'starting', 'running', 'stopping', 'unknown'] as const) {
      expect(isSessionActive(state), state).toBe(true);
    }
    for (const state of ['stopped', 'exited', 'failed', 'interrupted'] as const) {
      expect(isSessionActive(state), state).toBe(false);
    }
  });

  it('implements all three modes, and says why an agent that cannot run a remote one is refused', () => {
    expect(IMPLEMENTED_EXECUTION_MODES).toEqual(['local', 'remote_volatile', 'remote_snapshot']);
    expect(EXECUTION_MODE_UNAVAILABLE_REASONS.remote_volatile).toMatch(/Remote Volatile/);
    expect(EXECUTION_MODE_UNAVAILABLE_REASONS.remote_snapshot).toMatch(/Remote Snapshot/);
  });

  it('runs a remote mode only on a working copy, and the local mode never on one', () => {
    const base = {
      agentId: '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e5f60',
      emulatorType: 'qemu',
      vmName: 'Win98',
      requestId: '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e5f61',
    };
    const workspaceId = '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e5f62';
    expect(launchRequestSchema.safeParse({ ...base, mode: 'local' }).success).toBe(true);
    expect(launchRequestSchema.safeParse({ ...base, mode: 'local', workspaceId }).success).toBe(
      false,
    );
    for (const mode of ['remote_volatile', 'remote_snapshot']) {
      expect(launchRequestSchema.safeParse({ ...base, mode }).success, mode).toBe(false);
      expect(launchRequestSchema.safeParse({ ...base, mode, workspaceId }).success, mode).toBe(
        true,
      );
    }
  });

  it('has recovery advice for each code an administrator can act on', () => {
    for (const code of EXECUTION_ERROR_CODES) {
      if (code === 'internal_error') continue;
      expect(executionRecovery(code), code).not.toBeNull();
    }
    expect(executionRecovery('some_code_from_a_newer_agent')).toBeNull();
    expect(verifyRecovery('vm_running')).not.toBeNull();
  });
});
