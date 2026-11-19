import {
  addFiles, directoryAt, getDraft, getDrafts, getFolder, noteFilename, organizeNote, putDraft, readWrite,
  rememberFolder, removeDraft, requireFolder, scanFolder, withFilesLock,
} from './files.js';
import { readBackup, readMarkdown, readVivaldi, safeName, writeMarkdown } from './markdown.js';
import { createMarkdownEditor } from './markdown-editor.js';
import { noteArea, noteFolderLimit, originalPath } from './note-locations.js';

const element = (id) => document.getElementById(id);
const inputs = {
  title: element('title'),
  url: element('url'),
  body: createMarkdownEditor(element('body'), () => queueSave()),
};
const folderSelect = element('folders');
const search = element('search');
const noteList = element('notes');
const dialog = element('folder-dialog');
const purgeDialog = element('purge-dialog');
const viewButtons = element('note-views').querySelectorAll('button');
const pickerOptions = { id: 'side-notes-folder', startIn: 'documents', mode: 'readwrite' };
const folderActions = [
  'new-note', 'new-folder', 'reload', 'import-markdown', 'import-vivaldi', 'export-backup', 'import-backup',
];
const collator = new Intl.Collator('ja', { numeric: true });
const settingsPage = new URLSearchParams(location.search).has('settings');
const folderEvents = new BroadcastChannel('side-notes-folders');
const pathKey = (path) => JSON.stringify(path);
const folderLabel = (path) => path.join(' / ') || '保存先直下';
const errorText = (error) => error?.message || '処理に失敗しました。';
let folder;
let canWrite = false;
let notes = [];
let folders = [];
let editor;
let busy = false;
let clipsChanged = false;
let settingsChange;
let jsonReader;
let view = 'active';
let pendingPurge;
let selecting = false;
let visibleNotes = [];
const selection = new Map();

async function worker(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response || typeof response !== 'object') {
    const recovery = message.draftId ? '「Markdownをダウンロード」で原稿を保存してから、' : '';
    throw new Error(`QuickMemoから応答がありません。${recovery}chrome://extensions でQuickMemoを再読み込みしてください。`);
  }
  if (response.error) throw new Error(response.error);
  return response.result;
}

function message(text = '') {
  element('notice').textContent = text;
}

function updateControls() {
  for (const id of folderActions) element(id).disabled = busy || !canWrite;
  element('new-note').disabled ||= view !== 'active';
  element('folder-controls').hidden = view !== 'active';
  for (const button of viewButtons) {
    button.disabled = busy || !canWrite;
    button.setAttribute('aria-pressed', String(button.dataset.area === view));
  }
  folderSelect.disabled = busy || !canWrite;
  search.disabled = busy || !canWrite;
  element('choose-folder').disabled = busy;
  element('open-settings').disabled = busy;
  element('authorize-folder').hidden = !folder || canWrite;
  element('authorize-folder').disabled = busy;
  const libraryName = element('library-name');
  libraryName.textContent = folder?.handle.name || '保存先未設定';
  libraryName.title = libraryName.textContent;
  for (const field of Object.values(inputs)) field.readOnly = busy || editor?.area !== 'active';
  element('retry-save').disabled = busy || !canWrite || editor?.area !== 'active' || editor.folderId !== folder?.id;
  element('save-copy').disabled = busy || !canWrite;
  element('download-draft').disabled = busy;
  element('close-draft').disabled = busy;
  element('open-draft').disabled = busy;
  const actions = {
    'archive-note': editor?.area === 'active',
    'trash-note': editor?.area === 'active' || editor?.area === 'archive',
    'restore-note': editor?.area === 'archive' || editor?.area === 'trash',
    'purge-note': editor?.area === 'trash',
  };
  for (const [id, visible] of Object.entries(actions)) {
    element(id).hidden = !visible || editor.failed;
    element(id).disabled = busy || !canWrite || editor?.folderId !== folder?.id;
  }
  updateSelectionControls();
}

async function updateFolderAccess() {
  const current = folder;
  const granted = Boolean(current && await current.handle.queryPermission(readWrite) === 'granted');
  if (folder !== current) return;
  canWrite = granted;
  updateControls();
}

async function run(task) {
  if (busy) return;
  busy = true;
  message();
  updateControls();
  try {
    await task();
  } catch (error) {
    if (error.name !== 'AbortError') {
      message(errorText(error));
      await updateFolderAccess().catch(console.error);
    }
  } finally {
    busy = false;
    updateControls();
    updateClips().catch(console.error);
    updateDraftList().catch(console.error);
    applySettingsChange();
  }
}

function selectedFolder() {
  return folderSelect.value === '*' ? [] : JSON.parse(folderSelect.value);
}

function renderFolders() {
  const selected = folderSelect.value;
  const options = folders.filter((path) => noteArea(path) === 'active')
    .sort((a, b) => collator.compare(a.join('/'), b.join('/')))
    .map((path) => new Option(folderLabel(path), pathKey(path)));
  folderSelect.replaceChildren(new Option('すべてのフォルダ', '*'), ...options);
  folderSelect.value = options.some((option) => option.value === selected) ? selected : '*';
}

function searchText(value) {
  return value.normalize('NFKC').toLocaleLowerCase('ja');
}

function updateSelectionControls() {
  const disabled = busy || !canWrite;
  const toggle = element('selection-mode');
  toggle.disabled = disabled || (!selecting && !visibleNotes.length);
  toggle.textContent = selecting ? '選択をやめる' : '複数選択';
  toggle.setAttribute('aria-pressed', String(selecting));
  const all = element('select-visible');
  all.hidden = !selecting;
  all.disabled = disabled || !visibleNotes.length;
  all.textContent = selection.size && selection.size === visibleNotes.length ? 'すべて解除' : '表示中をすべて選択';
  const count = element('selection-count');
  count.hidden = !selecting;
  count.textContent = selecting ? `${selection.size}件選択中` : '';
  const action = element('selection-action');
  action.hidden = !selecting;
  action.disabled = disabled || !selection.size;
  action.textContent = view === 'trash' ? '完全に削除' : 'ゴミ箱へ移動';
  action.classList.toggle('danger', view === 'trash');
  for (const checkbox of noteList.querySelectorAll('input[type="checkbox"]')) checkbox.disabled = disabled;
}

function setSelected(note, checked) {
  const key = pathKey(note.path);
  if (checked) selection.set(key, { path: note.path, raw: note.raw });
  else selection.delete(key);
}

function renderNotes() {
  const terms = searchText(search.value).trim().split(/\s+/).filter(Boolean);
  const selected = selectedFolder();
  visibleNotes = notes.filter((note) => {
    if (noteArea(note.path) !== view) return false;
    if (view === 'active' && folderSelect.value !== '*' && pathKey(note.folder) !== pathKey(selected)) return false;
    const text = searchText(`${note.title}\n${note.body}\n${note.url}`);
    return terms.every((term) => text.includes(term));
  }).sort((a, b) => b.lastmod.localeCompare(a.lastmod) || collator.compare(a.title, b.title));

  const visibleByPath = new Map(visibleNotes.map((note) => [pathKey(note.path), note]));
  for (const [key, target] of selection) {
    if (visibleByPath.get(key)?.raw !== target.raw) selection.delete(key);
  }
  noteList.replaceChildren(...visibleNotes.map((note) => {
    const row = document.createElement('li');
    const title = document.createElement('span');
    title.textContent = note.title || '無題';
    const labels = [title];
    const path = originalPath(note.folder);
    if (path.length) {
      const location = document.createElement('span');
      location.className = 'note-location';
      location.textContent = folderLabel(path);
      labels.push(location);
    }
    if (selecting) {
      const label = document.createElement('label');
      label.className = 'note-row note-choice';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = selection.has(pathKey(note.path));
      checkbox.addEventListener('change', () => {
        setSelected(note, checkbox.checked);
        updateSelectionControls();
      });
      const description = document.createElement('span');
      description.append(...labels);
      label.append(checkbox, description);
      row.append(label);
      return row;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'note-row';
    const isCurrent = editor?.folderId === folder?.id && pathKey(note.path) === editor?.key;
    button.setAttribute('aria-current', String(isCurrent));
    button.append(...labels);
    button.addEventListener('click', () => run(async () => {
      if (isCurrent) return;
      await settleEditor();
      openNote(note);
      renderNotes();
      noteList.querySelector('[aria-current="true"]')?.focus();
    }));
    row.append(button);
    return row;
  }));
  element('list-empty').hidden = !canWrite || visibleNotes.length !== 0;
  const emptyMessages = {
    active: 'このフォルダにメモはありません。',
    archive: 'アーカイブされたメモはありません。',
    trash: 'ゴミ箱は空です。',
  };
  element('list-empty').textContent = terms.length ? '検索に一致するメモがありません。' : emptyMessages[view];
  updateSelectionControls();
}

function sourceLink() {
  const link = element('open-source');
  try {
    const url = new URL(inputs.url.value);
    if (url.protocol === 'https:' || url.protocol === 'http:') {
      link.href = url.href;
      link.hidden = false;
      return;
    }
  } catch {
    // A partial URL is expected while typing.
  }
  link.removeAttribute('href');
  link.hidden = true;
}

function showSaveState(text, failed = false) {
  element('save-status').textContent = text;
  element('retry-save').hidden = !failed;
  element('save-copy').hidden = !failed;
  element('download-draft').hidden = !failed;
  element('close-draft').hidden = !failed;
}

function openNote(note, draft) {
  if (note) {
    selecting = false;
    selection.clear();
  }
  editor = note && {
    key: pathKey(note.path), path: note.path, name: note.name, folderId: draft?.folderId ?? folder.id,
    area: noteArea(note.path),
    savedRaw: draft?.expected ?? note.raw, plannedRaw: note.raw, pending: new Set(),
    draftId: draft?.id ?? crypto.randomUUID(), failed: Boolean(draft),
  };
  element('note-editor').hidden = !editor;
  element('editor-empty').hidden = Boolean(editor);
  const prompt = view === 'active' ? 'メモを選ぶか、新規メモを作成してください。' : 'メモを選んでください。';
  element('editor-empty').textContent = canWrite ? prompt : '保存先フォルダを選んでください。';
  if (!editor) return;
  for (const [key, field] of Object.entries(inputs)) field.value = note[key];
  sourceLink();
  const states = { active: '保存済み', archive: 'アーカイブ済み', trash: 'ゴミ箱のメモ' };
  showSaveState(draft ? '未保存の下書きです。' : states[editor.area], Boolean(draft));
}

async function flushEditor() {
  inputs.body.flush();
  await Promise.all(editor?.pending ?? []);
}

async function settleEditor() {
  await flushEditor();
  if (editor?.failed) throw new Error('編集中のメモを再保存するか、コピーを保存してください。');
}

function editorFields(previous) {
  return Object.fromEntries(Object.entries(inputs).map(([key, field]) => {
    const value = previous[key];
    // Text inputs strip line breaks; textareas display all line endings as LF.
    const displayed = value.replace(/\r\n?|\n/g, key === 'body' ? '\n' : '');
    return [key, field.value === displayed ? value : field.value];
  }));
}

function queueSave(current = editor, retry = false) {
  if (!current || current.area !== 'active') return;
  const draftOnly = current.failed && !retry;
  const expected = retry ? current.savedRaw : current.plannedRaw;
  const previous = readMarkdown(current.plannedRaw, current.name);
  const fields = editorFields(previous);
  const changed = Object.entries(fields).some(([key, value]) => value !== previous[key]);
  if (!changed && !retry) return;
  const markdown = changed
    ? writeMarkdown({ ...previous, ...fields, lastmod: new Date().toISOString() }, previous)
    : current.plannedRaw;
  current.plannedRaw = markdown;
  if (!draftOnly) showSaveState('保存中…');
  const pending = worker({
    type: draftOnly ? 'save-draft' : 'save-note', draftId: current.draftId,
    folderId: current.folderId, path: current.path, expected, markdown,
  })
    .then(() => {
      if (draftOnly) return;
      if (current.plannedRaw === markdown) current.failed = false;
      current.savedRaw = markdown;
      const note = notes.find((item) => pathKey(item.path) === current.key);
      if (note) Object.assign(note, readMarkdown(markdown, current.name), { raw: markdown });
    })
    .catch((error) => {
      current.failed = true;
      showSaveState(`未保存。${errorText(error)}`, true);
    })
    .finally(() => {
      current.pending.delete(pending);
      if (current.pending.size === 0 && !current.failed) {
        showSaveState('保存済み');
        renderNotes();
        if (clipsChanged && !busy) updateClips().catch(console.error);
      }
      if (current.pending.size === 0 && current.failed) updateFolderAccess().catch(console.error);
    });
  current.pending.add(pending);
}

function skippedWarning(skipped) {
  if (!skipped.length) return '';
  const example = skipped[0];
  return `読み込めない項目 ${skipped.length}件を除外しました（例: ${example.path.join('/')}、${example.reason}）。`;
}

async function refresh({ resetEditor = false, selectPath } = {}) {
  if (!canWrite) return;
  const data = await withFilesLock(async () => scanFolder(await requireFolder(folder.id)));
  notes = data.notes;
  folders = data.folders;
  const warning = element('scan-warning');
  warning.hidden = data.skipped.length === 0;
  warning.textContent = skippedWarning(data.skipped);
  if (resetEditor || selectPath) {
    const key = selectPath ? pathKey(selectPath) : editor?.key;
    openNote(notes.find((note) => pathKey(note.path) === key));
  } else if (editor && editor.folderId === folder.id && !editor.failed && !editor.pending.size &&
      !notes.some((note) => pathKey(note.path) === editor.key)) {
    inputs.body.flush();
    if (!editor.pending.size) {
      openNote(null);
      updateControls();
    }
  }
  renderFolders();
  renderNotes();
}

async function openFolder() {
  canWrite = Boolean(folder && await folder.handle.queryPermission(readWrite) === 'granted');
  folders = [];
  notes = [];
  selecting = false;
  selection.clear();
  showSelectionErrors([]);
  view = 'active';
  element('scan-warning').hidden = true;
  search.value = '';
  if (!editor?.failed) openNote(null);
  renderFolders();
  renderNotes();
  if (canWrite) {
    const result = await worker({ type: 'flush-clips' }).catch((error) => {
      message(errorText(error));
      return 0;
    });
    if (result) message(`保留中のクリップを${result}件保存しました。`);
    await refresh();
  } else if (folder) {
    message('Chromeでフォルダへのアクセスを許可してください。');
  }
}

async function updateClips() {
  const [pending, errors] = await Promise.all([
    chrome.storage.local.get(null), chrome.storage.session.get('clip-save-error'),
  ]);
  const clips = Object.entries(pending).filter(([key]) => key.startsWith('clip:')).map(([, clip]) => clip);
  const elsewhere = clips.filter((clip) => clip.folderId && clip.folderId !== folder?.id).length;
  const here = clips.length - elsewhere;
  const label = element('clip-count');
  const failed = errors['clip-save-error'];
  label.hidden = clips.length === 0 && !failed;
  label.textContent = [
    failed ? 'クリップを保留できませんでした。ページからもう一度「メモに保存」を試してください。' : '',
    here ? `保留中のクリップ ${here}件。保存先を開くと保存します。` : '',
    elsewhere ? `別の保存先に保留中のクリップ ${elsewhere}件。元の保存先を選ぶと保存します。` : '',
  ].filter(Boolean).join(' ');
  if (clipsChanged && !settingsPage && !busy && canWrite && !editor?.pending.size && !editor?.failed) {
    clipsChanged = false;
    await refresh();
  }
}

async function updateDraftList() {
  if (settingsPage) return;
  const drafts = (await withFilesLock(getDrafts)).filter((draft) => draft.id !== editor?.draftId);
  const select = element('draft-list');
  const previous = select.value;
  select.replaceChildren(...drafts.sort((left, right) => right.updated - left.updated)
    .map((draft) => new Option(draft.title || '無題', draft.id)));
  if (drafts.some((draft) => draft.id === previous)) select.value = previous;
  element('drafts').hidden = drafts.length === 0;
}

async function createNote({ copy = false } = {}) {
  const original = editor;
  if (copy) await flushEditor();
  else await settleEditor();
  const now = new Date().toISOString();
  const previous = copy ? readMarkdown(original.plannedRaw, original.name) : null;
  const note = copy ? {
    ...previous, ...editorFields(previous), lastmod: now,
  } : { title: '無題', body: '', url: '', date: now, lastmod: now };
  const sameFolder = copy && original.folderId === folder.id;
  const parts = sameFolder && original.area === 'active' &&
      folders.some((path) => pathKey(path) === pathKey(original.path.slice(0, -1)))
    ? original.path.slice(0, -1) : selectedFolder();
  const path = [...parts, noteFilename(note.title)];
  await worker({ type: 'save-note', folderId: folder.id, path, expected: null, markdown: writeMarkdown(note, previous) });
  if (copy) await withFilesLock(() => removeDraft(original.draftId));
  view = 'active';
  search.value = '';
  if (copy && folderSelect.value !== '*') folderSelect.value = pathKey(parts);
  await refresh({ selectPath: path });
  return true;
}

async function importEntries(entries, skipped = []) {
  await settleEditor();
  const warning = skippedWarning(skipped);
  if (entries.length === 0) {
    message(['取り込めるメモがありません。', warning].filter(Boolean).join(' '));
    return;
  }
  try {
    const count = await withFilesLock(async () => addFiles(await requireFolder(folder.id), entries));
    message([`${count}件を追加しました。`, warning].filter(Boolean).join(' '));
  } finally {
    await refresh();
    folderEvents.postMessage('files');
  }
}

async function performNoteAction(action, target) {
  if (!target || editor !== target || target.folderId !== folder?.id) {
    message('メモの選択が変わりました。対象を選び直してください。');
    return false;
  }
  await settleEditor();
  const result = {
    archive: 'アーカイブしました。', trash: 'ゴミ箱に移動しました。',
    restore: 'メモを元に戻しました。', purge: 'メモを完全に削除しました。',
  };
  let failure;
  try {
    await withFilesLock(async () => {
      const root = await requireFolder(target.folderId);
      await organizeNote(root, {
        action, folderId: target.folderId, path: target.path, expected: target.savedRaw,
      });
    });
    openNote(null);
  } catch (error) {
    failure = error;
  }
  folderEvents.postMessage('files');
  try {
    await refresh();
  } catch (error) {
    if (!failure) {
      message(`${result[action]}一覧の更新に失敗しました。再読み込みしてください。`);
      return true;
    }
  }
  if (failure) throw failure;
  message(result[action]);
  return true;
}

async function organizeSelectedNote(action, target = editor) {
  let completed = false;
  await run(async () => { completed = await performNoteAction(action, target); });
  if (completed) element('note-views').querySelector('[aria-pressed="true"]')?.focus();
}

function showSelectionErrors(failures) {
  const details = element('selection-errors');
  details.hidden = !failures.length;
  details.open = Boolean(failures.length);
  element('selection-error-list').replaceChildren(...failures.map(({path, error}) => {
    const item = document.createElement('li');
    item.textContent = `${path.join(' / ')} — ${error}`;
    return item;
  }));
}

async function organizeSelection({ action, folderId, area, targets }) {
  let processed = false;
  await run(async () => {
    const selectionChanged = targets.some((target) => selection.get(pathKey(target.path)) !== target);
    if (!selecting || view !== area || folder?.id !== folderId || selectionChanged) {
      throw new Error('表示が変わりました。対象を選び直してください。');
    }
    await settleEditor();
    let succeeded = 0;
    const failures = [];
    await withFilesLock(async () => {
      const root = await requireFolder(folderId);
      for (const target of targets) {
        try {
          await organizeNote(root, { action, folderId, path: target.path, expected: target.raw });
          selection.delete(pathKey(target.path));
          succeeded++;
        } catch (error) {
          failures.push({ path: target.path, error: errorText(error) });
        }
      }
    });
    processed = true;
    showSelectionErrors(failures);
    folderEvents.postMessage('files');
    const result = action === 'purge' ? 'を完全に削除しました。' : 'をゴミ箱に移動しました。';
    const failed = failures.length ? ` ${failures.length}件を処理できませんでした。` : '';
    const warning = await refresh().then(() => '', () => ' 一覧を再読み込みしてください。');
    message(`${succeeded}件${result}${failed}${warning}`);
  });
  if (processed) element('selection-mode').focus();
}

function openSettings() {
  return run(async () => {
    await chrome.tabs.create({ url: chrome.runtime.getURL('sidepanel.html?settings') });
  });
}

element('open-settings').addEventListener('click', openSettings);
element('close-settings').addEventListener('click', async () => {
  const tab = await chrome.tabs.getCurrent();
  if (tab?.id) await chrome.tabs.remove(tab.id);
});

element('choose-folder').addEventListener('click', () => run(async () => {
  const handle = await window.showDirectoryPicker(pickerOptions);
  await settleEditor();
  folder = await rememberFolder(handle);
  folderEvents.postMessage('folder');
  await openFolder();
}));

element('authorize-folder').addEventListener('click', () => {
  return run(async () => {
    let permission;
    try {
      permission = await folder.handle.requestPermission(readWrite);
    } catch (error) {
      if (settingsPage || error.name === 'AbortError') throw error;
      message('設定タブからアクセスを許可してください。');
      return;
    }
    if (permission !== 'granted' && !settingsPage) {
      message('設定タブからアクセスを許可してください。');
      return;
    }
    folderEvents.postMessage('folder');
    await flushEditor();
    await openFolder();
  });
});

element('reload').addEventListener('click', () => run(async () => {
  await settleEditor();
  await worker({ type: 'flush-clips' });
  await refresh({ resetEditor: true });
  message('保存先を読み直しました。');
}));

element('new-note').addEventListener('click', async () => {
  let created = false;
  await run(async () => { created = await createNote(); });
  if (created) inputs.title.select();
});

element('new-folder').addEventListener('click', () => {
  element('folder-name').value = '';
  dialog.returnValue = '';
  dialog.showModal();
  element('folder-name').focus();
});

dialog.addEventListener('close', () => {
  if (dialog.returnValue !== 'create') return;
  run(async () => {
    const name = element('folder-name').value.trim();
    if (!name || safeName(name, '') !== name) throw new Error('フォルダ名に使えない文字があります。');
    const path = [...selectedFolder(), name];
    if (noteArea(path) !== 'active') throw new Error('この名前はQuickMemoの管理フォルダに使われます。');
    if (path.length > noteFolderLimit(path)) throw new Error('フォルダの階層が深すぎます。');
    await withFilesLock(async () => directoryAt(await requireFolder(folder.id), path, true));
    await refresh();
    folderSelect.value = pathKey(path);
    selection.clear();
    renderNotes();
  });
});

for (const button of viewButtons) {
  button.addEventListener('click', () => run(async () => {
    if (view === button.dataset.area) return;
    await settleEditor();
    view = button.dataset.area;
    selection.clear();
    showSelectionErrors([]);
    openNote(null);
    renderNotes();
  }));
}

element('archive-note').addEventListener('click', () => organizeSelectedNote('archive'));
element('trash-note').addEventListener('click', () => organizeSelectedNote('trash'));
element('restore-note').addEventListener('click', () => organizeSelectedNote('restore'));
function confirmPurge(text, confirm) {
  pendingPurge = confirm;
  purgeDialog.returnValue = '';
  element('purge-message').textContent = `${text}この操作は元に戻せません。`;
  purgeDialog.showModal();
}

element('purge-note').addEventListener('click', () => {
  const target = editor;
  confirmPurge(`「${inputs.title.value || '無題'}」のファイルを削除します。`,
    () => organizeSelectedNote('purge', target));
});
purgeDialog.addEventListener('submit', (event) => {
  if (event.submitter?.value !== 'purge') return;
  event.preventDefault();
  const confirm = pendingPurge;
  pendingPurge = undefined;
  purgeDialog.close();
  confirm?.();
});
purgeDialog.addEventListener('close', () => {
  if (purgeDialog.open) return;
  pendingPurge = undefined;
  applySettingsChange();
});

element('selection-mode').addEventListener('click', () => run(async () => {
  await settleEditor();
  selecting = !selecting;
  selection.clear();
  if (selecting) openNote(null);
  renderNotes();
}));
element('select-visible').addEventListener('click', () => {
  const selectAll = selection.size !== visibleNotes.length;
  selection.clear();
  if (selectAll) for (const note of visibleNotes) setSelected(note, true);
  renderNotes();
});
element('selection-action').addEventListener('click', () => {
  if (!selecting || !selection.size) return;
  const action = view === 'trash' ? 'purge' : 'trash';
  const request = { action, folderId: folder.id, area: view, targets: [...selection.values()] };
  if (action === 'purge') {
    confirmPurge(`${request.targets.length}件のメモを完全に削除します。`, () => organizeSelection(request));
  } else {
    organizeSelection(request);
  }
});

function changeNoteFilter() {
  selection.clear();
  renderNotes();
}

folderSelect.addEventListener('change', changeNoteFilter);
search.addEventListener('input', changeNoteFilter);
for (const field of [inputs.title, inputs.url]) {
  field.addEventListener('input', (event) => {
    if (field === inputs.url) sourceLink();
    if (!event.isComposing) queueSave();
  });
  field.addEventListener('compositionend', () => queueSave());
}

element('retry-save').addEventListener('click', () => run(async () => {
  await flushEditor();
  queueSave(editor, true);
  await Promise.all(editor.pending);
}));

element('save-copy').addEventListener('click', () => run(() => createNote({ copy: true })));

element('open-draft').addEventListener('click', () => run(async () => {
  await settleEditor();
  const id = element('draft-list').value;
  const draft = await withFilesLock(async () => {
    const record = await getDraft(id);
    if (!record) throw new Error('この下書きは既に開かれたか、保存されています。');
    const opened = { ...record, id: crypto.randomUUID() };
    await putDraft(opened);
    await removeDraft(id);
    return opened;
  });
  const name = draft.path.at(-1);
  view = noteArea(draft.path);
  openNote({ ...readMarkdown(draft.markdown, name), path: draft.path, name, raw: draft.markdown }, draft);
  renderNotes();
}));

element('download-draft').addEventListener('click', () => {
  inputs.body.flush();
  const url = URL.createObjectURL(new Blob([editor.plannedRaw], { type: 'text/markdown;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = noteFilename(inputs.title.value);
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
});

element('close-draft').addEventListener('click', () => run(async () => {
  const current = editor;
  await flushEditor();
  if (current.failed) {
    const draft = await withFilesLock(() => getDraft(current.draftId));
    if (draft?.markdown !== current.plannedRaw) {
      throw new Error('下書きを保存できていません。再保存するか、Markdown をダウンロードしてください。');
    }
  }
  openNote(null);
  renderNotes();
}));

element('import-markdown').addEventListener('click', () => run(async () => {
  const source = await window.showDirectoryPicker({ id: 'import-notes', startIn: 'documents' });
  if (await source.resolve(folder.handle) !== null || await folder.handle.resolve(source) !== null) {
    throw new Error('取り込み元と保存先が重ならないフォルダを選んでください。');
  }
  const { notes: entries, skipped } = await scanFolder(source);
  await importEntries(entries, skipped);
}));

const importFile = element('import-file');

function chooseJson(read) {
  jsonReader = read;
  importFile.value = '';
  importFile.click();
}

importFile.addEventListener('change', () => run(async () => {
  const file = importFile.files[0];
  if (!file) return;
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    throw new Error('選んだファイルを読み込めません。');
  }
  await importEntries(jsonReader(data));
  importFile.value = '';
}));

element('import-vivaldi').addEventListener('click', () => chooseJson(readVivaldi));
element('import-backup').addEventListener('click', () => chooseJson(readBackup));

element('export-backup').addEventListener('click', () => run(async () => {
  const handle = await window.showSaveFilePicker({
    suggestedName: `side-notes-${new Date().toISOString().slice(0, 10)}.json`,
    types: [{ description: 'JSON バックアップ', accept: { 'application/json': ['.json'] } }],
  });
  await settleEditor();
  await refresh();
  const files = notes.map((note) => ({ path: note.path, markdown: note.raw }));
  const backup = JSON.stringify({ format: 'side-notes', version: 1, files }, null, 2);
  const writable = await handle.createWritable();
  try {
    await writable.write(backup);
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => {});
    throw error;
  }
  message(`${files.length}件を書き出しました。`);
}));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && 'clip-save-error' in changes) {
    updateClips().catch(console.error);
    return;
  }
  if (area !== 'local' || !Object.keys(changes).some((key) => key.startsWith('clip:'))) return;
  clipsChanged = true;
  updateClips().catch(console.error);
});

function applySettingsChange() {
  if (busy || purgeDialog.open || !settingsChange) return;
  const changed = settingsChange;
  settingsChange = null;
  run(async () => {
    await flushEditor();
    if (changed === 'folder') {
      folder = await getFolder();
      await openFolder();
      if (editor?.failed && editor.folderId !== folder?.id) {
        showSaveState('保存先が変わりました。「コピーを保存」で編集中の内容を残せます。', true);
      }
    } else {
      await refresh();
    }
  });
}

folderEvents.addEventListener('message', ({ data }) => {
  if (settingsChange !== 'folder') settingsChange = data;
  applySettingsChange();
});

if (settingsPage) {
  document.body.classList.add('settings-page');
  element('page-title').textContent = 'メモの設定';
  document.querySelector('main').hidden = true;
  for (const id of ['new-note', 'open-settings', 'reload']) element(id).hidden = true;
  for (const id of ['close-settings', 'file-actions', 'folder-help']) element(id).hidden = false;
}

run(async () => {
  folder = await getFolder();
  await openFolder();
});
