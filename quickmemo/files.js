import { readMarkdown, safeName, validPathPart } from './markdown.js';
import { collectionFolders, noteArea, noteFolderLimit, originalPath } from './note-locations.js';

const folderKey = 'active-folder';
const knownFoldersKey = 'known-folders';
export const readWrite = { mode: 'readwrite' };
export const withFilesLock = (task) => navigator.locks.request('side-notes-files', task);
const unreadableEntries = new Set(['NotFoundError', 'NotAllowedError', 'SecurityError', 'NotReadableError']);

async function transactionFor(storeName, mode, action) {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('side-notes', 2);
    request.onupgradeneeded = ({ oldVersion }) => {
      if (oldVersion === 0) request.result.createObjectStore('settings');
      request.result.createObjectStore('drafts', { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, mode);
      const request = action(transaction.objectStore(storeName));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

const folderStore = (mode, action) => transactionFor('settings', mode, action);
const draftStore = (mode, action) => transactionFor('drafts', mode, action);
export const getDraft = (id) => draftStore('readonly', (store) => store.get(id));
export const getDrafts = () => draftStore('readonly', (store) => store.getAll());
export const putDraft = (draft) => draftStore('readwrite', (store) => store.put(draft));
export const removeDraft = (id) => draftStore('readwrite', (store) => store.delete(id));

export function getFolder() {
  return folderStore('readonly', (store) => store.get(folderKey));
}

export function rememberFolder(handle) {
  return withFilesLock(async () => {
    const known = await folderStore('readonly', (store) => store.get(knownFoldersKey)) ?? [];
    const active = await getFolder();
    if (active && !known.some((folder) => folder.id === active.id)) known.push(active);
    let id;
    for (const candidate of known) {
      if (await handle.isSameEntry(candidate.handle)) {
        id = candidate.id;
        break;
      }
    }
    const folder = { id: id ?? crypto.randomUUID(), handle };
    await folderStore('readwrite', (store) => {
      store.put([...known.filter((item) => item.id !== folder.id), folder], knownFoldersKey);
      return store.put(folder, folderKey);
    });
    return folder;
  });
}

export async function requireFolder(id) {
  const folder = await getFolder();
  if (!folder || (id && folder.id !== id) ||
      await folder.handle.queryPermission(readWrite) !== 'granted') {
    throw new Error('保存先フォルダを開き直してください。');
  }
  return folder.handle;
}

export async function directoryAt(root, parts, create = false) {
  let current = root;
  for (const name of parts) {
    if (!validPathPart(name)) throw new Error('フォルダ名を読み込めません。');
    current = await current.getDirectoryHandle(name, { create });
  }
  return current;
}

export async function scanFolder(root) {
  const notes = [];
  const folders = [[]];
  const skipped = [];
  async function scan(dir, folder) {
    for await (const [name, handle] of dir.entries()) {
      const path = [...folder, name];
      try {
        if (handle.kind === 'directory') {
          if (path.length > noteFolderLimit(path)) {
            skipped.push({ path, reason: '階層の上限' });
            continue;
          }
          await scan(handle, path);
          folders.push(path);
        } else if (/\.md$/i.test(name)) {
          const raw = await readFile(handle);
          notes.push({ folder, name, path, raw, ...readMarkdown(raw, name) });
        }
      } catch (error) {
        if (error.name === 'UnsupportedEncoding') skipped.push({ path, reason: 'UTF-8 以外の文字コード' });
        else if (unreadableEntries.has(error.name)) skipped.push({ path, reason: '移動やアクセス権限' });
        else throw error;
      }
    }
  }
  await scan(root, []);
  return { folders, notes, skipped };
}

async function readFile(handle) {
  const file = await handle.getFile();
  const bytes = await file.arrayBuffer();
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    const error = new Error(`「${file.name}」は UTF-8 の Markdown ファイルとして読み込めません。`);
    error.name = 'UnsupportedEncoding';
    throw error;
  }
}

async function existingFile(directory, name) {
  try {
    return await directory.getFileHandle(name);
  } catch (error) {
    if (error.name === 'NotFoundError') return null;
    throw error;
  }
}

async function writeFile(handle, raw, verify) {
  const writer = await handle.createWritable();
  try {
    await writer.write(raw);
    await verify();
    await writer.close();
  } catch (error) {
    await writer.abort().catch(() => {});
    throw error;
  }
}

async function createFile(directory, name, raw) {
  const handle = await directory.getFileHandle(name, { create: true });
  const verify = async () => {
    if ((await handle.getFile()).size !== 0) throw new Error(`「${name}」は既に存在します。`);
  };
  await verify();
  await writeFile(handle, raw, verify);
}

export async function saveNote(root, path, expected, markdown) {
  if (!Array.isArray(path) || !path.every(validPathPart) || !/\.md$/i.test(path.at(-1)) ||
      typeof markdown !== 'string') throw new Error('メモの保存先が無効です。');
  const directory = await directoryAt(root, path.slice(0, -1));
  const name = path.at(-1);
  const handle = await existingFile(directory, name);
  if (expected === null && !handle) {
    await createFile(directory, name, markdown);
    return;
  }
  const before = handle ? await readFile(handle) : null;
  if (expected !== null && before === markdown) return;
  const verify = (current) => {
    if (!handle || current !== expected) {
      throw new Error('ファイルが別の場所で変更されています。編集中の内容は「コピーを保存」で残せます。');
    }
  };
  verify(before);
  await writeFile(handle, markdown, async () => verify(await readFile(handle)));
}

const noteActions = {
  active: new Set(['archive', 'trash']),
  archive: new Set(['restore', 'trash']),
  trash: new Set(['restore', 'purge']),
};

async function freeNoteName(directory, preferred) {
  const base = safeName(preferred.slice(0, -3));
  for (let index = 1; ; index++) {
    const name = index === 1 ? preferred : `${base}-${index}.md`;
    try {
      if (!await existingFile(directory, name)) return name;
    } catch (error) {
      if (error.name !== 'TypeMismatchError') throw error;
    }
  }
}

export async function organizeNote(root, { action, folderId, path, expected }) {
  if (!folderId || !Array.isArray(path) || !path.every(validPathPart) ||
      !/\.md$/i.test(path.at(-1)) || typeof expected !== 'string' ||
      !noteActions[noteArea(path)].has(action)) {
    throw new Error('このメモには選択した操作を実行できません。');
  }
  const name = path.at(-1);
  const source = await directoryAt(root, path.slice(0, -1));
  const verifySource = async () => {
    const handle = await existingFile(source, name);
    if (!handle || await readFile(handle) !== expected) {
      throw new Error('メモが別の場所で変更されました。再読み込みしてから、もう一度操作してください。');
    }
  };
  await verifySource();
  if (action === 'purge') {
    await source.removeEntry(name);
    return;
  }

  const previous = originalPath(path);
  const parts = noteArea(previous) === 'active' ? previous.slice(0, -1) : [];
  const destinationPath = action === 'restore' ? parts : [collectionFolders[action], ...parts];
  const destination = await directoryAt(root, destinationPath, true);
  const target = await freeNoteName(destination, name);
  // Moving a real local file via FileSystemHandle.move is not supported in all Chrome versions.
  await createFile(destination, target, expected);
  const verifyCopy = async () => {
    const handle = await existingFile(destination, target);
    if (!handle || await readFile(handle) !== expected) throw new Error('移動先のコピーが変更されました。');
  };
  const id = crypto.randomUUID();
  // Record the last saved bytes before making any irreversible change to the source.
  await putDraft({ id, folderId, path, expected, markdown: expected,
    title: readMarkdown(expected, name).title, updated: Date.now() });
  try {
    await verifyCopy();
    await verifySource();
    await source.removeEntry(name);
    await verifyCopy();
  } catch (error) {
    const [sourceIntact, copyIntact] = await Promise.allSettled([verifySource(), verifyCopy()]);
    if (sourceIntact.status === 'fulfilled' || copyIntact.status === 'fulfilled') {
      await removeDraft(id).catch(console.error);
    }
    const details = copyIntact.status === 'fulfilled'
      ? `コピーの場所は「${[...destinationPath, target].join('/')}」です。`
      : sourceIntact.status === 'fulfilled'
        ? '元のメモは残っています。'
        : '「下書きを開く」から移動前のメモを復旧できます。';
    throw new Error(`移動を完了できませんでした。${details}${error.message}`);
  }
  await removeDraft(id).catch(console.error);
}

async function fingerprint(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest, 0, 8), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function importDestination(directory, name, raw) {
  try {
    const file = await existingFile(directory, name);
    if (!file) return 'available';
    return await readFile(file) === raw ? 'same' : 'occupied';
  } catch (error) {
    if (error.name === 'TypeMismatchError' || error.name === 'UnsupportedEncoding') return 'occupied';
    throw error;
  }
}

export async function addFiles(root, entries) {
  let added = 0;
  try {
    for (const entry of entries) {
      const directory = await directoryAt(root, entry.folder, true);
      let name = entry.source ? `${safeName(entry.title)}-${await fingerprint(entry.source)}.md` : entry.name;
      let status = await importDestination(directory, name, entry.raw);
      if (status === 'occupied') {
        const base = `${safeName(name.slice(0, -3))}-${await fingerprint(entry.raw)}`;
        for (let index = 1; status === 'occupied'; index++) {
          name = index === 1 ? `${base}.md` : `${base}-${index}.md`;
          status = await importDestination(directory, name, entry.raw);
        }
      }
      if (status === 'same') continue;
      await createFile(directory, name, entry.raw);
      added++;
    }
  } catch (error) {
    throw new Error(`${added}件の追加後に読み込みを停止しました。${error.message}`);
  }
  return added;
}

export function noteFilename(title) {
  return `${safeName(title)}-${crypto.randomUUID().slice(0, 12)}.md`;
}
