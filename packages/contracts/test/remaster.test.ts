import { describe, expect, it } from 'vitest';
import {
  AGENT_REGISTRATION_MODES,
  archiveDeletePayloadSchema,
  createSnapshotRequestSchema,
  localRemasterRequestSchema,
  normalizeVersionDescription,
  normalizeVersionTitle,
  promoteSnapshotRequestSchema,
  REMASTER_REFUSALS,
  REMASTER_REFUSAL_TEXT,
  registrationRequestPayloadSchema,
  remasterPhase,
  remasterPlan,
  restoreSyncPayloadSchema,
  updateVersionDetailsRequestSchema,
  VERSION_DESCRIPTION_MAX_LENGTH,
  VERSION_TITLE_MAX_LENGTH,
} from '../src/index.js';

const id = (n: number) => `018f47a0-7c2b-4f7e-9a3d-${String(n).padStart(12, '0')}`;
const node = (n: number, parent: number | null) => ({
  id: id(n),
  parentVersionId: parent === null ? null : id(parent),
});

describe('remaster plans follow lineage, never dates', () => {
  // M0 ─ S1 ─ S2 ─ S3 ─ S4
  const linear = [node(0, null), node(1, 0), node(2, 1), node(3, 2), node(4, 3)];

  it('keeps the promoted snapshot and its descendants, and removes its ancestors', () => {
    expect(remasterPlan(linear, id(2))).toEqual({
      retained: [id(2), id(3), id(4)],
      removed: [id(0), id(1)],
    });
  });

  it('promoting the earliest snapshot removes only the master', () => {
    expect(remasterPlan(linear, id(1))).toEqual({
      retained: [id(1), id(2), id(3), id(4)],
      removed: [id(0)],
    });
  });

  it('promoting the latest snapshot keeps it alone', () => {
    expect(remasterPlan(linear, id(4))).toEqual({
      retained: [id(4)],
      removed: [id(0), id(1), id(2), id(3)],
    });
  });

  it('removes unrelated branches and keeps the promoted one whole', () => {
    // M0 ─ S1 ┬ S2 ─ S4
    //         └ S3
    const branching = [node(0, null), node(1, 0), node(3, 1), node(2, 1), node(4, 2)];
    expect(remasterPlan(branching, id(2))).toEqual({
      retained: [id(2), id(4)],
      removed: [id(0), id(1), id(3)],
    });
  });

  it('ignores the order nodes come in, so creation time cannot change the answer', () => {
    const shuffled = [node(4, 3), node(2, 1), node(0, null), node(3, 2), node(1, 0)];
    const plan = remasterPlan(shuffled, id(3));
    expect(new Set(plan?.retained)).toEqual(new Set([id(3), id(4)]));
    expect(new Set(plan?.removed)).toEqual(new Set([id(0), id(1), id(2)]));
  });

  it('refuses a graph that is not one tree, or a version that is not in it', () => {
    expect(remasterPlan(linear, id(9))).toBeNull();
    expect(remasterPlan([node(0, null), node(1, 7)], id(0))).toBeNull();
    expect(remasterPlan([node(0, null), node(1, null)], id(0))).toBeNull();
    expect(
      remasterPlan(
        [
          node(0, null),
          { id: id(1), parentVersionId: id(2) },
          { id: id(2), parentVersionId: id(1) },
        ],
        id(0),
      ),
    ).toBeNull();
    expect(remasterPlan([node(0, null), node(0, null)], id(0))).toBeNull();
  });
});

describe('titles and descriptions are plain text', () => {
  it('trims a title, and treats an empty one as none', () => {
    expect(normalizeVersionTitle('  Clean install  ')).toBe('Clean install');
    expect(normalizeVersionTitle('   ')).toBeNull();
    expect(normalizeVersionTitle(null)).toBeNull();
  });

  it('keeps a description’s line breaks, and only trims around the whole text', () => {
    expect(normalizeVersionDescription('\n  Line one\r\n\r\n  Line two  \n\n')).toBe(
      'Line one\n\n  Line two',
    );
    expect(normalizeVersionDescription(' \r\n ')).toBeNull();
  });

  it('accepts exactly the maximum lengths, in characters rather than UTF-16 units', () => {
    const parse = (title: string | null, description: string | null) =>
      updateVersionDetailsRequestSchema.safeParse({ title, description });
    expect(parse('t'.repeat(VERSION_TITLE_MAX_LENGTH), null).success).toBe(true);
    expect(parse('t'.repeat(VERSION_TITLE_MAX_LENGTH + 1), null).success).toBe(false);
    expect(parse('😀'.repeat(VERSION_TITLE_MAX_LENGTH), null).success).toBe(true);
    expect(parse(null, 'd'.repeat(VERSION_DESCRIPTION_MAX_LENGTH)).success).toBe(true);
    expect(parse(null, 'd'.repeat(VERSION_DESCRIPTION_MAX_LENGTH + 1)).success).toBe(false);
    // Whitespace around the text does not count against the limit.
    expect(parse(`  ${'t'.repeat(VERSION_TITLE_MAX_LENGTH)}  `, null).success).toBe(true);
  });

  it('refuses control characters, and line breaks in a title', () => {
    const parse = (title: string | null, description: string | null) =>
      updateVersionDetailsRequestSchema.safeParse({ title, description });
    expect(parse('One\nTwo', null).success).toBe(false);
    expect(parse('Bell\u0007', null).success).toBe(false);
    expect(parse(null, 'Tab\tand\nbreak').success).toBe(true);
    expect(parse(null, 'Null\u0000').success).toBe(false);
  });

  it('keeps markup exactly as typed: it is text, never interpreted', () => {
    const parsed = updateVersionDetailsRequestSchema.parse({
      title: '<script>alert(1)</script>',
      description: '<b>bold</b> & <img src=x onerror=alert(1)>',
    });
    expect(parsed).toEqual({
      title: '<script>alert(1)</script>',
      description: '<b>bold</b> & <img src=x onerror=alert(1)>',
    });
  });

  it('requires both fields when editing, so that a clear is explicit', () => {
    expect(updateVersionDetailsRequestSchema.safeParse({ title: 'x' }).success).toBe(false);
    expect(
      updateVersionDetailsRequestSchema.safeParse({ title: 'x', description: null, extra: 1 })
        .success,
    ).toBe(false);
  });

  it('lets a snapshot be created with or without them', () => {
    const base = { agentId: id(1), parentVersionId: id(2), requestId: id(3) };
    expect(createSnapshotRequestSchema.parse(base)).toEqual(base);
    expect(
      createSnapshotRequestSchema.parse({ ...base, title: ' Patched ', description: '' }),
    ).toEqual({ ...base, title: 'Patched', description: null });
  });
});

describe('remaster requests and messages', () => {
  const revision = 'f'.repeat(64);

  it('name the history they were confirmed against', () => {
    expect(promoteSnapshotRequestSchema.safeParse({ requestId: id(1) }).success).toBe(false);
    expect(
      promoteSnapshotRequestSchema.safeParse({ requestId: id(1), expectedRevision: revision })
        .success,
    ).toBe(true);
    expect(
      localRemasterRequestSchema.safeParse({
        agentId: id(1),
        requestId: id(2),
        expectedRevision: revision,
      }).success,
    ).toBe(false);
  });

  it('never tell an agent to remaster: it is told to copy', () => {
    expect(AGENT_REGISTRATION_MODES).not.toContain('remaster');
    expect(
      registrationRequestPayloadSchema.safeParse({
        operationId: id(1),
        emulatorType: 'qemu',
        vmName: 'Win98',
        mode: 'remaster',
        repositoryId: id(2),
        versionId: id(3),
        archiveKey: 'archives/qemu/win98/x.zip',
      }).success,
    ).toBe(false);
  });

  it('can ask an agent to delete a VirtualBox OVA, which it says it can do', () => {
    const payload = {
      operationId: id(1),
      versionId: id(2),
      emulatorType: 'virtualbox',
      vmName: 'Win2k',
      repositoryId: id(3),
      archiveKey: `archives/virtualbox/win2k/${id(2)}.ova`,
      archiveSizeBytes: 10,
      archiveSha256: 'a'.repeat(64),
    };
    expect(archiveDeletePayloadSchema.safeParse(payload).success).toBe(true);
    const sync = restoreSyncPayloadSchema.parse({
      operations: [],
      capabilities: {
        emulators: [],
        repositoryIds: [],
        cacheMaxBytes: 0,
        cacheUsedBytes: 0,
        deleteArchives: true,
        deleteVirtualBoxArchives: true,
      },
      localCopies: [],
    });
    expect(sync.capabilities.deleteVirtualBoxArchives).toBe(true);
  });

  it('show each step, and complete only after cleanup', () => {
    expect(remasterPhase('exporting', 'archiving')).toBe('exporting');
    expect(remasterPhase('exporting', 'uploading')).toBe('uploading');
    expect(remasterPhase('exporting', 'verifying')).toBe('verifying');
    expect(remasterPhase('exporting', 'committing')).toBe('committing');
    expect(remasterPhase('cleaning', 'cleaning_local')).toBe('cleaning');
    expect(remasterPhase('completed', 'succeeded')).toBe('completed');
    expect(remasterPhase('failed', 'failed')).toBe('failed');
  });

  it('explain every refusal', () => {
    for (const refusal of REMASTER_REFUSALS) expect(REMASTER_REFUSAL_TEXT[refusal]).toBeTruthy();
  });
});
