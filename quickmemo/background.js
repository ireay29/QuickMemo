import { addFiles, getDraft, getFolder, matchesFolderId, organizeNote, putDraft, removeDraft, requireFolder, saveNote, withFilesLock } from './files.js';
import { readMarkdown, titleFromText, writeMarkdown } from './markdown.js';

const clipKey = 'clip:';

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'save-selection',
      title: 'メモに保存',
      contexts: ['selection'],
      documentUrlPatterns: ['http://*/*', 'https://*/*'],
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'save-selection' || !info.selectionText?.trim()) return;
  if (tab?.windowId >= 0) chrome.sidePanel.open({ windowId: tab.windowId }).catch(console.error);
  saveSelection(info).catch(async (error) => {
    console.error(error);
    await chrome.storage.session.set({ 'clip-save-error': true });
  }).catch(console.error);
});

async function saveSelection(info) {
  const folder = await getFolder();
  const key = `${clipKey}${crypto.randomUUID()}`;
  const title = titleFromText(info.selectionText);
  const now = new Date().toISOString();
  const raw = writeMarkdown({
    title, url: info.pageUrl ?? '', date: now, lastmod: now, body: info.selectionText,
  });
  await chrome.storage.local.set({ [key]: { title, raw, folderId: folder?.id ?? null } });
  await chrome.storage.session.remove('clip-save-error').catch(console.error);
  // Keep the clip in Chrome until it has reached the chosen folder.
  await flushClips().catch(() => {});
}

async function flushClips() {
  const queued = await chrome.storage.local.get(null);
  if (!Object.keys(queued).some((key) => key.startsWith(clipKey))) return 0;
  return withFilesLock(async () => {
    const storage = await chrome.storage.local.get(null);
    const folder = await getFolder();
    if (!folder) return 0;
    const pending = Object.entries(storage).filter(([key, clip]) =>
      key.startsWith(clipKey) && (!clip.folderId || matchesFolderId(folder, clip.folderId)));
    if (!pending.length) return 0;
    const unassigned = Object.fromEntries(pending.filter(([, clip]) => !clip.folderId)
      .map(([key, clip]) => [key, { ...clip, folderId: folder.id }]));
    if (Object.keys(unassigned).length) await chrome.storage.local.set(unassigned);
    const root = await requireFolder(folder.id);
    let added = 0;
    for (const [key, clip] of pending) {
      added += await addFiles(root, [{ ...clip, source: key, folder: [] }]);
      await chrome.storage.local.remove(key);
    }
    return added;
  });
}

function writeNote(message) {
  return withFilesLock(async () => {
    const { folderId, path, expected, markdown, draftId } = message;
    if (draftId) {
      const previous = await getDraft(draftId);
      await putDraft({
        id: draftId, folderId, path, markdown,
        expected: previous?.markdown === expected ? previous.expected : expected,
        title: readMarkdown(markdown, path.at(-1)).title,
        updated: Date.now(),
      });
    }
    if (message.type === 'save-draft') return;
    const root = await requireFolder(folderId);
    await saveNote(root, path, expected, markdown);
    if (draftId) await removeDraft(draftId);
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  let operation;
  if (message?.type === 'save-note' || message?.type === 'save-draft') {
    operation = writeNote(message);
  } else if (message?.type === 'organize-note') {
    operation = withFilesLock(async () => organizeNote(await requireFolder(message.folderId), message));
  } else if (message?.type === 'flush-clips') {
    operation = flushClips();
  } else {
    return false;
  }
  operation.then((result) => sendResponse({ result }), (error) => sendResponse({ error: error.message }));
  return true;
});
