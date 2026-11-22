/**
 * Per-VM Markdown notes (decision 0053): the routes, the exact file layout, optimistic concurrency, atomic writes,
 * and refusal of every way out of the notes root.
 */
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vmNotesSchema, type VmNotes } from '@emucat/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NotesError, NotesStorage, notesEtag } from '../src/notes/storage.js';
import {
  insertVm,
  signedInAdmin,
  startBrowserApp,
  TestClient,
  type BrowserTestContext,
} from './browser-app.js';

let context: BrowserTestContext;
let admin: TestClient;
let notesRoot: string;

beforeEach(async () => {
  context = await startBrowserApp();
  admin = await signedInAdmin(context);
  notesRoot = join(context.storageRoot, 'notes');
  await insertVm(context.pool, {
    emulatorType: '86box',
    vmName: 'Windows 95',
    visibility: 'public',
  });
  await insertVm(context.pool, { vmName: 'Win98' });
});

afterEach(async () => {
  await context.close();
});

const url = (emulatorType: string, vmName: string) =>
  `/admin/vms/${emulatorType}/${encodeURIComponent(vmName)}/notes`;

async function load(emulatorType = '86box', vmName = 'Windows 95'): Promise<VmNotes> {
  const response = await admin.get(url(emulatorType, vmName));
  expect(response.statusCode, response.body).toBe(200);
  const notes = vmNotesSchema.parse(response.json());
  expect(response.headers.etag).toBe(notes.etag);
  expect(response.headers['cache-control']).toContain('no-store');
  return notes;
}

function save(
  markdown: string,
  etag: string | undefined,
  emulatorType = '86box',
  vmName = 'Windows 95',
) {
  return admin.request({
    method: 'PUT',
    url: url(emulatorType, vmName),
    headers: etag === undefined ? {} : { 'if-match': etag },
    payload: { markdown },
  });
}

describe('VM notes', () => {
  it('starts empty, then creates, reads, updates and clears one Markdown file', async () => {
    const empty = await load();
    expect(empty).toEqual({
      markdown: '',
      exists: false,
      etag: notesEtag(''),
      updatedAt: null,
      sizeBytes: 0,
    });

    const created = await save('# Installation\n\n1. Boot from floppy\n', empty.etag);
    expect(created.statusCode, created.body).toBe(200);
    const first = vmNotesSchema.parse(created.json());
    expect(first).toMatchObject({
      markdown: '# Installation\n\n1. Boot from floppy\n',
      exists: true,
    });
    expect(first.etag).toBe(notesEtag(first.markdown));

    // The exact path: data/notes/<emu name>/<vm name>/<vm name> - notes.md, and nothing else there.
    const path = join(notesRoot, '86box', 'Windows 95', 'Windows 95 - notes.md');
    expect(await readFile(path, 'utf8')).toBe(first.markdown);
    expect(await readdir(join(notesRoot, '86box', 'Windows 95'))).toEqual([
      'Windows 95 - notes.md',
    ]);
    expect((await stat(path)).mode & 0o777).toBe(0o640);

    expect(await load()).toEqual(first);

    const updated = await save('Known issues: none', first.etag);
    expect(updated.statusCode).toBe(200);
    expect(await readFile(path, 'utf8')).toBe('Known issues: none');

    const cleared = await admin.request({
      method: 'DELETE',
      url: url('86box', 'Windows 95'),
      headers: { 'if-match': vmNotesSchema.parse(updated.json()).etag },
    });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(vmNotesSchema.parse(cleared.json())).toMatchObject({ markdown: '', exists: false });
    // The file and its now-empty directories go: nothing is orphaned.
    await expect(stat(join(notesRoot, '86box', 'Windows 95'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('saving an empty document removes the file, as clearing does', async () => {
    const first = vmNotesSchema.parse((await save('x', (await load()).etag)).json());
    const emptied = await save('', first.etag);
    expect(emptied.statusCode).toBe(200);
    expect(vmNotesSchema.parse(emptied.json()).exists).toBe(false);
    await expect(stat(join(notesRoot, '86box', 'Windows 95'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('uses the registered spelling of the VM, whatever the request says', async () => {
    const response = await save('spelled', notesEtag(''), '86box', 'WINDOWS 95');
    expect(response.statusCode, response.body).toBe(200);
    expect(await readdir(join(notesRoot, '86box'))).toEqual(['Windows 95']);
    expect((await load('86box', 'windows 95')).markdown).toBe('spelled');
  });

  it('keeps Unicode content exactly, and allows every character VM names may have', async () => {
    await insertVm(context.pool, { vmName: 'OS_2 Warp-4.52' });
    const markdown = 'Ünïcödé — 日本語 — 🖥️\n\n| a | b |\n|---|---|\n| `x` | **y** |\n';
    const response = await save(markdown, notesEtag(''), 'qemu', 'OS_2 Warp-4.52');
    expect(response.statusCode, response.body).toBe(200);
    expect(
      await readFile(
        join(notesRoot, 'qemu', 'OS_2 Warp-4.52', 'OS_2 Warp-4.52 - notes.md'),
        'utf8',
      ),
    ).toBe(markdown);
    expect((await load('qemu', 'OS_2 Warp-4.52')).markdown).toBe(markdown);
  });

  it('refuses a save based on notes that changed since, and one with no tag', async () => {
    const empty = await load();
    expect((await save('first', empty.etag)).statusCode).toBe(200);
    const stale = await save('second', empty.etag);
    expect(stale.statusCode).toBe(412);
    expect(stale.json<{ error: { code: string } }>().error.code).toBe('notes_conflict');
    expect((await load()).markdown).toBe('first');
    const missing = await save('third', undefined);
    expect(missing.statusCode).toBe(428);
    const malformed = await save('third', 'W/"abc"');
    expect(malformed.statusCode).toBe(400);
    expect((await load()).markdown).toBe('first');
  });

  it('lets exactly one of two concurrent saves of the same notes win, and never mixes them', async () => {
    const empty = await load();
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, index) => save(`writer ${index}\n`.repeat(2000), empty.etag)),
    );
    const statuses = results.map((result) => result.statusCode).sort();
    expect(statuses).toEqual([200, 412, 412, 412, 412, 412]);
    const winner = results.find((result) => result.statusCode === 200);
    const stored = await readFile(
      join(notesRoot, '86box', 'Windows 95', 'Windows 95 - notes.md'),
      'utf8',
    );
    expect(stored).toBe(vmNotesSchema.parse(winner?.json()).markdown);
    // No temporary file is left behind.
    expect(await readdir(join(notesRoot, '86box', 'Windows 95'))).toEqual([
      'Windows 95 - notes.md',
    ]);
  });

  it('survives a restart of the API: the file is the notes', async () => {
    expect((await save('persistent', notesEtag(''))).statusCode).toBe(200);
    const restarted = await context.buildAnother();
    const client = new TestClient(restarted);
    client.cookie = admin.cookie;
    client.csrfToken = admin.csrfToken;
    const response = await client.get(url('86box', 'Windows 95'));
    expect(response.statusCode, response.body).toBe(200);
    expect(vmNotesSchema.parse(response.json()).markdown).toBe('persistent');
  });

  it('refuses names that could reach outside, and VMs that do not exist', async () => {
    for (const name of ['..', '../x', '..%2F..%2Fetc', '.hidden', 'a\\b', 'CON']) {
      const response = await admin.get(`/admin/vms/86box/${name}/notes`);
      expect([400, 404], name).toContain(response.statusCode);
    }
    expect((await admin.get(url('qemu', 'Missing'))).statusCode).toBe(404);
    expect((await admin.get('/admin/vms/dosbox/x/notes')).statusCode).toBe(400);
    await expect(readdir(notesRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('never follows a link out of the notes root, for reads or writes', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'emucat-outside-'));
    try {
      await writeFile(join(outside, 'Windows 95 - notes.md'), 'secret');
      // The VM's directory is a link to somewhere else.
      await mkdir(join(notesRoot, '86box'), { recursive: true });
      await symlink(outside, join(notesRoot, '86box', 'Windows 95'));
      const read = await admin.get(url('86box', 'Windows 95'));
      expect(read.statusCode).toBe(500);
      expect(read.json<{ error: { code: string } }>().error.code).toBe('notes_storage_unsafe');
      expect(read.body).not.toContain(outside);
      expect(read.body).not.toContain('secret');
      const write = await save('overwrite', notesEtag('secret'));
      expect(write.statusCode).toBe(500);
      expect(await readFile(join(outside, 'Windows 95 - notes.md'), 'utf8')).toBe('secret');

      // The notes file itself is a link.
      await rm(join(notesRoot, '86box', 'Windows 95'));
      await mkdir(join(notesRoot, '86box', 'Windows 95'));
      await symlink(
        join(outside, 'Windows 95 - notes.md'),
        join(notesRoot, '86box', 'Windows 95', 'Windows 95 - notes.md'),
      );
      expect((await admin.get(url('86box', 'Windows 95'))).statusCode).toBe(500);
      expect((await save('overwrite', notesEtag('secret'))).statusCode).toBe(500);
      expect(await readFile(join(outside, 'Windows 95 - notes.md'), 'utf8')).toBe('secret');

      // The emulator's directory is a link.
      await rm(join(notesRoot, '86box'), { recursive: true });
      await symlink(outside, join(notesRoot, '86box'));
      expect((await admin.get(url('86box', 'Windows 95'))).statusCode).toBe(500);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('refuses notes over the size limit, and NUL characters', async () => {
    const big = await save('x'.repeat(1024 * 1024 + 1), notesEtag(''));
    expect([400, 413]).toContain(big.statusCode);
    expect((await save('a\0b', notesEtag(''))).statusCode).toBe(400);
    expect((await load()).exists).toBe(false);
  });

  it('is private: administrators only, and never in a public response', async () => {
    expect((await save('private notes', notesEtag(''))).statusCode).toBe(200);
    const anonymous = new TestClient(context.app);
    expect((await anonymous.get(url('86box', 'Windows 95'))).statusCode).toBe(401);
    const write = await anonymous.request({
      method: 'PUT',
      url: url('86box', 'Windows 95'),
      headers: { 'if-match': notesEtag('') },
      payload: { markdown: 'x' },
    });
    expect([401, 403]).toContain(write.statusCode);
    const publicDetail = await anonymous.get('/catalog/vms/86box/Windows%2095');
    expect(publicDetail.statusCode).toBe(200);
    expect(publicDetail.body).not.toContain('private notes');
    const admins = await admin.get('/admin/vms/86box/Windows%2095');
    expect(admins.body).not.toContain('private notes');
  });

  it('answers 503 when the server has no notes storage', async () => {
    const without = await context.buildAnother({ notes: undefined });
    const client = new TestClient(without);
    client.cookie = admin.cookie;
    const response = await client.get(url('86box', 'Windows 95'));
    expect(response.statusCode).toBe(503);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('notes_unavailable');
  });
});

describe('NotesStorage', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'emucat-notes-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('refuses identities that are not catalog identities', async () => {
    const storage = new NotesStorage(root);
    for (const vmName of ['..', 'a/b', 'a\\b', '', '.x', 'x.']) {
      await expect(storage.read({ emulatorType: 'qemu', vmName })).rejects.toBeInstanceOf(
        NotesError,
      );
    }
    await expect(
      storage.read({ emulatorType: '../etc' as 'qemu', vmName: 'x' }),
    ).rejects.toBeInstanceOf(NotesError);
  });

  it('refuses a notes root that is a link', async () => {
    const real = join(root, 'real');
    await mkdir(real);
    await symlink(real, join(root, 'link'));
    const storage = new NotesStorage(join(root, 'link'));
    await expect(storage.read({ emulatorType: 'qemu', vmName: 'Win98' })).rejects.toMatchObject({
      kind: 'unsafe',
    });
  });

  it('removes temporary files a crash left, and deletes a VM’s notes for its deletion', async () => {
    const storage = new NotesStorage(root);
    const vm = { emulatorType: 'qemu' as const, vmName: 'Win98' };
    await storage.write(vm, 'first', notesEtag(''));
    const directory = join(root, 'qemu', 'Win98');
    const leftover = join(directory, '.Win98 - notes.md.00000000-0000-4000-8000-000000000000.tmp');
    await writeFile(leftover, 'partial');
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const { utimes } = await import('node:fs/promises');
    await utimes(leftover, old, old);
    await storage.write(vm, 'second', notesEtag('first'));
    expect(await readdir(directory)).toEqual(['Win98 - notes.md']);
    await storage.deleteForVm(vm);
    await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await storage.read(vm)).exists).toBe(false);
  });

  it('keeps notes per VM identity: another emulator with the same name is another file', async () => {
    const storage = new NotesStorage(root);
    await storage.write({ emulatorType: 'qemu', vmName: 'Same' }, 'qemu', notesEtag(''));
    await storage.write({ emulatorType: '86box', vmName: 'Same' }, '86box', notesEtag(''));
    expect((await storage.read({ emulatorType: 'qemu', vmName: 'Same' })).markdown).toBe('qemu');
    expect((await storage.read({ emulatorType: '86box', vmName: 'Same' })).markdown).toBe('86box');
  });
});
