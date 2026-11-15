import { describe, expect, it } from 'vitest';
import {
  agentMessageSchema,
  defaultVirtualBoxTargetName,
  isVirtualBoxOperationActive,
  registrationSyncPayloadSchema,
  serverMessageSchema,
  validateVirtualBoxTargetName,
  VIRTUALBOX_TARGET_NAME_MAX_LENGTH,
  virtualBoxOperationResultPayloadSchema,
} from '../src/index.js';
import { fixture } from './helpers.js';

type Example = { type: string; payload: Record<string, unknown> };
const all = fixture<Record<string, Example[] | undefined>>('wire-examples');

describe('VirtualBox management messages (decision 0046)', () => {
  it('accepts each one in its own direction only', () => {
    const server = all.virtualboxManagementServerMessages ?? [];
    const agent = all.virtualboxManagementAgentMessages ?? [];
    for (const example of server) {
      expect(serverMessageSchema.safeParse(example).success, JSON.stringify(example)).toBe(true);
      expect(agentMessageSchema.safeParse(example).success).toBe(false);
    }
    for (const example of agent) {
      expect(agentMessageSchema.safeParse(example).success, JSON.stringify(example)).toBe(true);
      expect(serverMessageSchema.safeParse(example).success).toBe(false);
    }
    expect(new Set(server.map((example) => example.type))).toEqual(
      new Set([
        'server.virtualbox_import',
        'server.virtualbox_delete',
        'server.virtualbox_operation_ack',
        'server.virtualbox_capture',
      ]),
    );
    expect(new Set(agent.map((example) => example.type))).toEqual(
      new Set([
        'agent.virtualbox_operation_progress',
        'agent.virtualbox_operation_result',
        'agent.virtualbox_capture',
      ]),
    );
  });

  it('refuses an option for a name, a path, a bad hash, and a name or a wildcard for a UUID', () => {
    const refused = all.virtualboxManagementRefused ?? [];
    expect(refused.length).toBeGreaterThan(0);
    for (const example of refused) {
      expect(serverMessageSchema.safeParse(example).success, JSON.stringify(example)).toBe(false);
    }
  });

  it('reads an older result without stray machines as having none', () => {
    const parsed = virtualBoxOperationResultPayloadSchema.parse({
      operationId: '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e8001',
      kind: 'delete',
      outcome: 'failed',
      code: 'delete_failed',
      message: 'refused',
      machine: null,
      filesRemoved: null,
    });
    expect(parsed.strayMachines).toEqual([]);
  });

  it('reads the sync of an agent that predates management as not capable', () => {
    const parsed = registrationSyncPayloadSchema.parse({
      operations: [],
      snapshots: true,
      virtualbox: true,
    });
    expect(parsed.virtualboxManagement).toBeFalsy();
    expect(parsed.virtualboxOperations ?? []).toEqual([]);
  });

  it('counts only queued and running operations as active', () => {
    expect(isVirtualBoxOperationActive('queued')).toBe(true);
    expect(isVirtualBoxOperationActive('running')).toBe(true);
    for (const state of ['succeeded', 'failed', 'uncertain'] as const) {
      expect(isVirtualBoxOperationActive(state)).toBe(false);
    }
  });
});

describe('the name of an imported machine', () => {
  it('accepts an ordinary name, accents and spaces included', () => {
    for (const name of ['Xenix 386', 'Windows XP (2026-11-15)', 'Città Ufficio', 'a.b-c_d']) {
      expect(validateVirtualBoxTargetName(name), name).toEqual({ ok: true });
    }
  });

  it('refuses what VirtualBox or Windows would misread', () => {
    expect(validateVirtualBoxTargetName('')).toEqual({ ok: false, code: 'empty' });
    expect(validateVirtualBoxTargetName('x'.repeat(VIRTUALBOX_TARGET_NAME_MAX_LENGTH + 1))).toEqual(
      {
        ok: false,
        code: 'too_long',
      },
    );
    for (const name of [
      'a/b',
      'a\\b',
      'C:x',
      'a*',
      'a?',
      'a"b',
      'a<b>',
      'a|b',
      'a\nb',
      'a\u0000',
    ]) {
      expect(validateVirtualBoxTargetName(name), JSON.stringify(name)).toEqual({
        ok: false,
        code: 'invalid_characters',
      });
    }
    for (const name of [' leading', 'trailing ', 'dot.', '-option', '--vsys=1']) {
      expect(validateVirtualBoxTargetName(name), name).toEqual({
        ok: false,
        code: 'invalid_boundary',
      });
    }
  });

  it('defaults to the title and the version, made valid', () => {
    expect(defaultVirtualBoxTargetName('Xenix 386', 'v2')).toBe('Xenix 386 (v2)');
    expect(defaultVirtualBoxTargetName('A/B: "C"', '2026-11-15')).toBe('A-B- -C- (2026-11-15)');
    expect(defaultVirtualBoxTargetName('-Leading', 'v1')).toBe('Leading (v1)');
    const long = defaultVirtualBoxTargetName('x'.repeat(300), 'v1');
    expect([...long].length).toBeLessThanOrEqual(VIRTUALBOX_TARGET_NAME_MAX_LENGTH);
    expect(validateVirtualBoxTargetName(long).ok).toBe(true);
  });
});
