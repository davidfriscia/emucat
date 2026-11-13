import { describe, expect, it } from 'vitest';
import {
  REGISTRATION_ERROR_CODES,
  SNAPSHOT_INELIGIBLE_REASONS,
  SNAPSHOT_INELIGIBLE_TEXT,
  agentMessageSchema,
  buildVersionTree,
  createRegistrationRequestSchema,
  createSnapshotRequestSchema,
  isWorkspaceActive,
  launchRequestSchema,
  registrationRecovery,
  serverMessageSchema,
  versionLineage,
  type VersionNode,
} from '../src/index.js';
import { fixture } from './helpers.js';

const id = (n: number) => `018f47a0-7c2b-4f7e-9a3d-${String(n).padStart(12, '0')}`;

function node(n: number, parent: number | null, minute = n): VersionNode {
  return {
    id: id(n),
    kind: parent === null ? 'master' : 'snapshot',
    parentVersionId: parent === null ? null : id(parent),
    childVersionIds: [],
    snapshotName: parent === null ? null : `Win98_2026010100${String(minute).padStart(2, '0')}`,
    createdAt: `2026-01-01T00:${String(minute).padStart(2, '0')}:00.000Z`,
    archiveSizeBytes: 10,
    archiveSha256: 'a'.repeat(64),
    manifest: null,
    repositoryName: 'repo',
    available: true,
    createdByAgentName: null,
    createdByDisplayName: null,
    holders: [],
  };
}

describe('the version tree', () => {
  it('keeps branches as branches, children ordered by creation', () => {
    // master ─▶ A ─▶ C
    //    └────▶ B
    const result = buildVersionTree([node(1, null), node(3, 1, 5), node(2, 1, 4), node(4, 3, 6)]);
    expect(result.ok).toBe(true);
    if (!result.ok || !result.root) throw new Error('unreachable');
    expect(result.count).toBe(4);
    expect(result.root.node.id).toBe(id(1));
    expect(result.root.children.map((child) => child.node.id)).toEqual([id(2), id(3)]);
    expect(result.root.children[1]?.children.map((child) => [child.node.id, child.depth])).toEqual([
      [id(4), 2],
    ]);
  });

  it('is empty for a VM without versions', () => {
    expect(buildVersionTree([])).toEqual({ ok: true, root: null, count: 0 });
  });

  it.each([
    ['several_roots', [node(1, null), node(2, null)]],
    ['unknown_parent', [node(1, null), node(2, 9)]],
    ['duplicate_id', [node(1, null), node(1, null)]],
    ['no_root', [node(2, 3), node(3, 2)]],
    ['cycle', [node(1, null), node(2, 3), node(3, 2)]],
  ] as const)('refuses a tree with %s', (problem, nodes) => {
    expect(buildVersionTree(nodes)).toMatchObject({ ok: false, problem });
  });

  it('refuses a node whose shape contradicts its kind', () => {
    expect(
      buildVersionTree([{ ...node(1, null), parentVersionId: id(2) }, node(2, null)]),
    ).toMatchObject({ ok: false, problem: 'master_with_parent' });
    expect(
      buildVersionTree([node(1, null), { ...node(2, 1), parentVersionId: null }]),
    ).toMatchObject({ ok: false, problem: 'snapshot_without_parent' });
  });

  it('gives the lineage of a version, root first', () => {
    const nodes = [node(1, null), node(2, 1), node(3, 2), node(4, 1)];
    expect(versionLineage(nodes, id(3))).toEqual([id(1), id(2), id(3)]);
    expect(versionLineage(nodes, id(4))).toEqual([id(1), id(4)]);
    expect(versionLineage(nodes, id(9))).toBeNull();
    expect(versionLineage([node(2, 3), node(3, 2)], id(2))).toBeNull();
  });
});

describe('snapshot requests', () => {
  it('names an agent, a parent and a request, and nothing else', () => {
    const request = { agentId: id(1), parentVersionId: id(2), requestId: id(3) };
    expect(createSnapshotRequestSchema.safeParse(request).success).toBe(true);
    expect(createSnapshotRequestSchema.safeParse({ ...request, path: 'C:/vm' }).success).toBe(
      false,
    );
    expect(createSnapshotRequestSchema.safeParse({ ...request, repositoryId: id(4) }).success).toBe(
      false,
    );
  });

  it('cannot be smuggled in as a registration', () => {
    expect(
      createRegistrationRequestSchema.safeParse({
        agentId: id(1),
        repositoryId: id(2),
        emulatorType: 'qemu',
        vmName: 'Win98',
        mode: 'snapshot',
        discoveryOperationId: id(3),
      }).success,
    ).toBe(false);
  });

  it('explains every reason a snapshot is refused, and every snapshot error', () => {
    for (const reason of SNAPSHOT_INELIGIBLE_REASONS) {
      expect(SNAPSHOT_INELIGIBLE_TEXT[reason]).toBeTruthy();
    }
    for (const code of [
      'snapshot_parent_mismatch',
      'snapshot_parent_unknown',
      'workspace_unavailable',
    ]) {
      expect(REGISTRATION_ERROR_CODES).toContain(code);
      expect(registrationRecovery(code)).not.toBeNull();
    }
  });
});

describe('Remote Snapshot', () => {
  it('needs a working copy to launch, and nothing else names one', () => {
    const base = { agentId: id(1), emulatorType: 'qemu', vmName: 'Win98', requestId: id(2) };
    expect(launchRequestSchema.safeParse({ ...base, mode: 'remote_snapshot' }).success).toBe(false);
    expect(
      launchRequestSchema.safeParse({ ...base, mode: 'remote_snapshot', workspaceId: id(3) })
        .success,
    ).toBe(true);
    expect(
      launchRequestSchema.safeParse({ ...base, mode: 'local', workspaceId: id(3) }).success,
    ).toBe(false);
    expect(launchRequestSchema.safeParse({ ...base, mode: 'local' }).success).toBe(true);
  });

  it('knows which working copies are active', () => {
    expect(isWorkspaceActive('ready')).toBe(true);
    expect(isWorkspaceActive('discarding')).toBe(true);
    expect(isWorkspaceActive('discarded')).toBe(false);
    expect(isWorkspaceActive('lost')).toBe(false);
  });
});

describe('shared wire examples', () => {
  const all = fixture<Record<string, unknown[]>>('wire-examples');

  it('accepts each snapshot message in its own direction only', () => {
    for (const example of all.snapshotServerMessages ?? []) {
      expect(serverMessageSchema.safeParse(example).success, JSON.stringify(example)).toBe(true);
      expect(agentMessageSchema.safeParse(example).success).toBe(false);
    }
    for (const example of all.snapshotAgentMessages ?? []) {
      expect(agentMessageSchema.safeParse(example).success, JSON.stringify(example)).toBe(true);
      expect(serverMessageSchema.safeParse(example).success).toBe(false);
    }
    expect(all.snapshotServerMessages?.length).toBeGreaterThan(0);
  });

  it('refuses a snapshot without a parent, a copy with one, and any path', () => {
    for (const example of all.snapshotRefusedByTheAgent ?? []) {
      expect(serverMessageSchema.safeParse(example).success, JSON.stringify(example)).toBe(false);
    }
    expect(all.snapshotRefusedByTheAgent?.length).toBeGreaterThan(0);
  });

  it('accepts each storage cleanup message in its own direction only', () => {
    for (const example of all.cleanupServerMessages ?? []) {
      expect(serverMessageSchema.safeParse(example).success, JSON.stringify(example)).toBe(true);
      expect(agentMessageSchema.safeParse(example).success).toBe(false);
    }
    for (const example of all.cleanupAgentMessages ?? []) {
      expect(agentMessageSchema.safeParse(example).success, JSON.stringify(example)).toBe(true);
      expect(serverMessageSchema.safeParse(example).success).toBe(false);
    }
    expect(all.cleanupServerMessages?.length).toBeGreaterThan(0);
    expect(all.cleanupAgentMessages?.length).toBeGreaterThan(0);
  });

  it('still understands the sync of an agent that can neither remove nor delete', () => {
    const older = fixture<Record<string, unknown>>('wire-examples').cleanupOlderAgentSync;
    expect(agentMessageSchema.safeParse(older).success).toBe(true);
  });

  it('refuses a cleanup command that carries a path, or a VM name that is not one', () => {
    for (const example of all.cleanupRefusedByTheAgent ?? []) {
      expect(serverMessageSchema.safeParse(example).success, JSON.stringify(example)).toBe(false);
    }
    expect(all.cleanupRefusedByTheAgent?.length).toBeGreaterThan(0);
  });
});
