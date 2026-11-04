import { describe, expect, it } from 'vitest';
import {
  archiveObjectKey,
  formatSnapshotName,
  isValidSnapshotName,
  newVmVersionId,
  parseSnapshotName,
  validateVersionLineage,
  vmVersionIdSchema,
  vmVersionSchema,
  type SnapshotTimestamp,
  type VmVersion,
} from '../src/index.js';
import { fixture } from './helpers.js';

const snapshots = fixture<{
  valid: { name: string; vmName: string; timestamp: SnapshotTimestamp }[];
  invalid: string[];
  formatted: { vmName: string; at: string; name: string }[];
}>('snapshot-names');
const wire = fixture<{ masterVersion: VmVersion; snapshotVersion: VmVersion }>('wire-examples');

describe('snapshot names', () => {
  it.each(snapshots.valid)('parses $name', ({ name, vmName, timestamp }) => {
    expect(parseSnapshotName(name)).toEqual({ vmName, timestamp });
  });

  it.each(snapshots.invalid)('rejects %j', (name) => {
    expect(parseSnapshotName(name)).toBeNull();
    expect(isValidSnapshotName(name)).toBe(false);
  });

  it.each(snapshots.formatted)('formats $at in UTC as $name', ({ vmName, at, name }) => {
    expect(formatSnapshotName(vmName, new Date(at))).toBe(name);
  });

  it('refuses to format a name for an invalid VM', () => {
    expect(() => formatSnapshotName('../evil', new Date())).toThrow(/Invalid VM name/);
  });

  it('refuses an invalid date', () => {
    expect(() => formatSnapshotName('a', new Date('nope'))).toThrow(/Invalid snapshot time/);
  });
});

describe('version identifiers', () => {
  it('generates distinct, well-formed IDs', () => {
    const ids = new Set(Array.from({ length: 1000 }, newVmVersionId));
    expect(ids.size).toBe(1000);
    for (const id of ids) expect(vmVersionIdSchema.safeParse(id).success).toBe(true);
  });

  it('does not accept a snapshot name as an ID', () => {
    expect(vmVersionIdSchema.safeParse('Win98_202601311530').success).toBe(false);
  });

  it('gives same-minute snapshots different archive keys', () => {
    const identity = { emulatorType: 'qemu', vmName: 'Win98' } as const;
    const name = formatSnapshotName('Win98', new Date('2026-01-31T15:30:00Z'));
    expect(formatSnapshotName('Win98', new Date('2026-01-31T15:30:59Z'))).toBe(name);
    expect(archiveObjectKey(identity, newVmVersionId())).not.toBe(
      archiveObjectKey(identity, newVmVersionId()),
    );
  });

  it('builds case-normalized archive keys from the ID', () => {
    expect(
      archiveObjectKey(
        { emulatorType: 'qemu', vmName: 'Win98' },
        '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e5f60',
      ),
    ).toBe('archives/qemu/win98/018f47a0-7c2b-4f7e-9a3d-1b2c3d4e5f60.zip');
  });
});

describe('version schema', () => {
  const { masterVersion: master, snapshotVersion: snapshot } = wire;

  it('accepts a master and a snapshot', () => {
    expect(vmVersionSchema.safeParse(master).success).toBe(true);
    expect(vmVersionSchema.safeParse(snapshot).success).toBe(true);
  });

  it('rejects a master with a parent or a snapshot name', () => {
    expect(vmVersionSchema.safeParse({ ...master, parentVersionId: snapshot.id }).success).toBe(
      false,
    );
    expect(
      vmVersionSchema.safeParse({ ...master, snapshotName: 'Win98_202601311530' }).success,
    ).toBe(false);
  });

  it('rejects a snapshot without a parent', () => {
    expect(vmVersionSchema.safeParse({ ...snapshot, parentVersionId: null }).success).toBe(false);
  });

  it('rejects a snapshot that is its own parent', () => {
    expect(vmVersionSchema.safeParse({ ...snapshot, parentVersionId: snapshot.id }).success).toBe(
      false,
    );
  });

  it('rejects a snapshot whose name belongs to another VM', () => {
    expect(
      vmVersionSchema.safeParse({ ...snapshot, snapshotName: 'Other_202601311530' }).success,
    ).toBe(false);
  });

  it('rejects an unknown kind and a malformed hash', () => {
    expect(vmVersionSchema.safeParse({ ...master, kind: 'incremental' }).success).toBe(false);
    expect(vmVersionSchema.safeParse({ ...master, archiveSha256: 'ABC' }).success).toBe(false);
  });
});

describe('version lineage', () => {
  const vm = { emulatorType: 'qemu', vmName: 'Win98' } as const;
  const master = { ...vm, id: 'm', kind: 'master', parentVersionId: null } as const;
  const snap = (id: string, parentVersionId: string) =>
    ({ ...vm, id, kind: 'snapshot', parentVersionId }) as const;

  it('accepts branching snapshots', () => {
    expect(
      validateVersionLineage([master, snap('a', 'm'), snap('b', 'm'), snap('c', 'a')]),
    ).toEqual([]);
  });

  it('requires a master', () => {
    expect(validateVersionLineage([snap('a', 'b'), snap('b', 'a')])).toContain('missing_master');
  });

  it('allows only one master', () => {
    expect(validateVersionLineage([master, { ...master, id: 'm2' }])).toContain('multiple_masters');
  });

  it('rejects dangling parents', () => {
    expect(validateVersionLineage([master, snap('a', 'gone')])).toEqual(
      expect.arrayContaining(['unknown_parent', 'unreachable_from_master']),
    );
  });

  it('rejects cycles detached from the master', () => {
    expect(validateVersionLineage([master, snap('a', 'b'), snap('b', 'a')])).toEqual([
      'unreachable_from_master',
    ]);
  });

  it('rejects versions from another VM', () => {
    expect(validateVersionLineage([master, { ...snap('a', 'm'), vmName: 'Other' }])).toContain(
      'mixed_vms',
    );
  });

  it('rejects duplicate IDs', () => {
    expect(validateVersionLineage([master, snap('a', 'm'), snap('a', 'm')])).toContain(
      'duplicate_id',
    );
  });
});
