export const collectionFolders = Object.freeze({
  archive: 'QuickMemo アーカイブ',
  trash: 'QuickMemo ゴミ箱',
});

const folderIdentity = (name) => name.normalize('NFC').toLowerCase();

export function noteArea(path) {
  const first = path.length ? folderIdentity(path[0]) : '';
  return Object.keys(collectionFolders).find((area) => folderIdentity(collectionFolders[area]) === first) ?? 'active';
}

export function originalPath(path) {
  return noteArea(path) === 'active' ? path : path.slice(1);
}

export function noteFolderLimit(path) {
  return noteArea(path) === 'active' ? 64 : 65;
}
