import { noteFolderLimit } from './note-locations.js';

const fields = ['title', 'url', 'date', 'lastmod'];
const mappingLine = /^( *)([\p{L}\p{N}_][\p{L}\p{N}_ .-]*|'(?:[^']|'')*'|"(?:[^"\\]|\\.)*"):(?=[ \t]|$)[ \t]*(.*)$/u;
const sequenceItem = /^-(?:\s|$)/;
const nodeProperties = /^(?:(?:&[^\s,\[\]{}]+|!<[^>]+>|![^\s,\[\]{}]*)(?:[ \t]+|$))+/;

function mappingAt(line) {
  const match = mappingLine.exec(line.replace(/\r?\n$/, ''));
  return match && { indent: match[1], key: readScalar(match[2]), spelling: match[2], value: match[3] };
}

function isContinuation(line, indent, value) {
  const text = line.trimStart();
  const indentation = line.length - text.length;
  return indentation > indent.length ||
    (indentation === indent.length && (!value || value.startsWith('#')) && sequenceItem.test(text));
}

function readHeader(text) {
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let indent;
  let current;
  const values = {};
  for (const line of lines) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const entry = mappingAt(line);
    if (entry && (indent === undefined || entry.indent === indent)) {
      indent = entry.indent;
      current = entry;
      const scalar = entry.value.replace(nodeProperties, '');
      if (fields.includes(entry.key) && !/^[>|]/.test(scalar)) {
        values[entry.key] = readScalar(scalar);
      }
    } else if (!current || !isContinuation(line, indent, current.value)) {
      return null;
    }
  }
  return indent !== undefined || !text.trim() ? { lines, indent: indent ?? '', values } : null;
}

function readScalar(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  return trimmed;
}

export function readMarkdown(raw, filename = '') {
  const bom = raw.startsWith('\uFEFF') ? '\uFEFF' : '';
  const text = raw.slice(bom.length);
  const header = /^---[ \t]*\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)/m.exec(text);
  const parsed = header?.index === 0 ? readHeader(header[1]) : null;
  const values = parsed?.values ?? {};
  return {
    title: values.title ?? filename.replace(/\.md$/i, ''),
    url: values.url ?? '',
    date: values.date ?? '',
    lastmod: values.lastmod ?? '',
    body: parsed ? text.slice(header[0].length) : text,
    lines: parsed?.lines ?? [],
    indent: parsed?.indent ?? '',
    newline: text.match(/\r?\n/)?.[0] ?? '\n',
    bom,
  };
}

export function writeMarkdown(note, previous = null) {
  const newline = previous?.newline ?? '\n';
  const lines = previous?.lines.slice() ?? [];
  const indent = previous?.indent ?? '';
  for (const field of fields) {
    if (previous && note[field] === previous[field]) continue;
    if (!previous && !note[field] && field !== 'title') continue;
    const value = String(note[field] ?? '');
    const encoded = field === 'date' || field === 'lastmod' ? value : JSON.stringify(value);
    const index = lines.findLastIndex((line) => {
      const entry = mappingAt(line);
      return entry?.key === field && entry.indent === indent;
    });
    if (index === -1) {
      lines.push(`${indent}${field}: ${encoded}${newline}`);
    } else {
      const { spelling, value: previousValue } = mappingAt(lines[index]);
      // Keep structured timestamps intact, including anchors other keys may reference.
      if (field === 'lastmod' && /^[&!*|>\[{]/.test(previousValue)) continue;
      const properties = nodeProperties.exec(previousValue)?.[0].trimEnd();
      const replacement = properties ? `${properties} ${encoded}` : encoded;
      let end = index + 1;
      for (let scan = end; scan < lines.length; scan++) {
        if (!lines[scan].trim()) continue;
        if (!isContinuation(lines[scan], indent, previousValue)) break;
        end = scan + 1;
      }
      lines.splice(index, end - index, `${indent}${spelling}: ${replacement}${newline}`);
    }
  }
  return `${previous?.bom ?? ''}---${newline}${lines.join('')}---${newline}${note.body}`;
}

export function safeName(value, fallback = '無題') {
  return [...value.normalize('NFC').replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, ' ')
    .trim().replace(/^[.]+|[. ]+$/g, '')].slice(0, 50).join('').trim() || fallback;
}

export function titleFromText(text) {
  const line = text.split(/\r?\n/).find((part) => part.trim()) ?? '';
  return [...line.trim().replace(/^#{1,6}\s+/, '')].slice(0, 72).join('') || '無題';
}

function vivaldiDate(value) {
  if (typeof value !== 'string' || !/^\d{1,19}$/.test(value) || Number(value) === 0) return '';
  const date = new Date(Number(BigInt(value) / 1000n - 11644473600000n));
  return Number.isFinite(date.getTime()) ? date.toISOString() : '';
}

export function readVivaldi(data) {
  if (data?.type !== 'folder' || !Array.isArray(data.children)) {
    throw new Error('Vivaldi の Notes ファイルを選んでください。');
  }
  const notes = [];
  function visit(node, folder, treePath) {
    switch (node?.type) {
      case 'note': {
        if (typeof node.content !== 'string') throw new Error('本文を読めないメモがあります。');
        const title = node.subject?.trim() || titleFromText(node.content);
        const raw = writeMarkdown({
          title,
          url: typeof node.url === 'string' ? node.url : '',
          date: vivaldiDate(node.date_added),
          lastmod: vivaldiDate(node.last_modified),
          body: node.content,
        });
        notes.push({ folder, title, raw, source: `vivaldi:${node.guid || node.id || treePath}` });
        break;
      }
      case 'folder':
        visitChildren(node, [...folder, safeName(node.subject || '', 'フォルダ')], treePath);
        break;
      case 'trash':
        visitChildren(node, [...folder, 'Vivaldi のゴミ箱'], treePath);
        break;
      case 'other':
        visitChildren(node, folder, treePath);
        break;
      default:
        throw new Error('この Notes ファイルには未対応の項目があります。');
    }
  }
  function visitChildren(node, folder, treePath) {
    if (!Array.isArray(node.children) || folder.length > 64) {
      throw new Error('Notes ファイルのフォルダ構造を読めません。');
    }
    node.children.forEach((child, index) => visit(child, folder, `${treePath}/${index}`));
  }
  visitChildren(data, [], '');
  return notes;
}

export function validPathPart(name) {
  return typeof name === 'string' && name !== '' && name !== '.' && name !== '..' &&
    !/[\/\\\u0000]/.test(name);
}

export function readBackup(data) {
  if (data?.format !== 'side-notes' || data.version !== 1 || !Array.isArray(data.files)) {
    throw new Error('QuickMemo から書き出した JSON ファイルを選んでください。');
  }
  return data.files.map((file) => {
    if (!file || !Array.isArray(file.path) || !file.path.every(validPathPart) ||
        file.path.length > noteFolderLimit(file.path) + 1 || !/\.md$/i.test(file.path.at(-1)) ||
        typeof file.markdown !== 'string') {
      throw new Error('バックアップに読み込めない項目があります。');
    }
    return { folder: file.path.slice(0, -1), name: file.path.at(-1), raw: file.markdown };
  });
}
