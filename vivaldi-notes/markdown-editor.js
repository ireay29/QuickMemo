import {
  Compartment, Decoration, EditorState, EditorView, HighlightStyle, ViewPlugin,
  defaultKeymap, history, historyKeymap, keymap, markdown, markdownLanguage,
  placeholder, syntaxHighlighting, syntaxTree, tags,
} from './vendor/codemirror.js';

const markdownStyle = HighlightStyle.define([
  { tag: [tags.heading1, tags.heading2], class: 'md-heading md-heading-large' },
  { tag: [tags.heading3, tags.heading4, tags.heading5, tags.heading6], class: 'md-heading' },
  { tag: tags.strong, class: 'md-strong' },
  { tag: tags.emphasis, class: 'md-emphasis' },
  { tag: tags.strikethrough, class: 'md-strike' },
  { tag: tags.monospace, class: 'md-code' },
  { tag: tags.link, class: 'md-link' },
  { tag: tags.processingInstruction, class: 'md-mark' },
]);

const hiddenMark = Decoration.replace({});
const protectedNodes = new Set([
  'InlineCode', 'FencedCode', 'CodeBlock', 'HTMLTag', 'HTMLBlock', 'Comment', 'CommentBlock',
  'URL', 'LinkLabel', 'LinkTitle', 'Autolink', 'LinkMark', 'HeaderMark', 'Escape', 'Entity',
  'TaskMarker', 'ListMark', 'QuoteMark', 'TableDelimiter', 'HorizontalRule',
]);

function markupDecorations(view) {
  const { doc, selection } = view.state;
  const editing = view.hasFocus ? selection.ranges.map(({ from, to }) => ({
    from: doc.lineAt(from).from, to: doc.lineAt(to).to,
  })) : [];
  const tree = syntaxTree(view.state);
  const seen = new Set();
  const marks = [];
  for (const range of view.visibleRanges) {
    tree.iterate({ ...range, enter(ref) {
      if (!['HeaderMark', 'EmphasisMark', 'CodeMark'].includes(ref.name)) return;
      const node = ref.node;
      const parent = node.parent;
      if (!parent || editing.some(({ from, to }) => parent.from <= to && parent.to > from)) return;
      if (ref.name === 'CodeMark' && parent.name !== 'InlineCode') return;
      if (ref.name === 'HeaderMark' && !parent.name.startsWith('ATXHeading')) return;
      if (seen.has(ref.from)) return;
      seen.add(ref.from);
      let end = ref.to;
      if (ref.name === 'HeaderMark' && ref.from === parent.from) {
        const line = doc.lineAt(end);
        end += /^[ \t]*/.exec(line.text.slice(end - line.from))[0].length;
      }
      marks.push(hiddenMark.range(ref.from, end));
    } });
  }
  return Decoration.set(marks, true);
}

const markdownMarks = ViewPlugin.fromClass(class {
  constructor(view) {
    this.decorations = markupDecorations(view);
  }

  update(update) {
    if (update.docChanged || update.selectionSet || update.viewportChanged || update.focusChanged ||
        syntaxTree(update.startState) !== syntaxTree(update.state)) {
      this.decorations = markupDecorations(update.view);
    }
  }
}, { decorations: (plugin) => plugin.decorations });

function formatBold(view) {
  if (view.state.readOnly || view.compositionStarted) return false;
  const { from, to } = view.state.selection.main;
  const selected = view.state.sliceDoc(from, to);
  const core = selected.trim();
  if (!core && selected) return true;
  const start = from + selected.length - selected.trimStart().length;
  const end = start + core.length;
  if (core.includes('\n')) return true;

  let protectedText = false;
  let bold;
  const cursor = start === end;
  const scanFrom = cursor ? Math.max(0, start - 1) : start;
  const scanTo = cursor ? Math.min(end + 1, view.state.doc.length) : end;
  syntaxTree(view.state).iterate({ from: scanFrom, to: scanTo, enter(ref) {
    const overlaps = cursor ? ref.from <= start && start <= ref.to : ref.from < end && ref.to > start;
    if (overlaps && protectedNodes.has(ref.name)) protectedText = true;
    if (ref.name === 'StrongEmphasis' && ref.node.firstChild?.name === 'EmphasisMark' &&
        ref.node.lastChild?.name === 'EmphasisMark' &&
        ref.node.firstChild.to === start && ref.node.lastChild.from === end) {
      bold = { from: ref.from, to: ref.to };
    }
  } });
  if (protectedText) return true;
  if (bold) {
    view.dispatch({ changes: { ...bold, insert: core },
      selection: { anchor: bold.from, head: bold.from + core.length }, userEvent: 'input.format' });
  } else {
    view.dispatch({ changes: { from: start, to: end, insert: `**${core}**` },
      selection: { anchor: start + 2, head: end + 2 }, userEvent: 'input.format' });
  }
  return true;
}

export function createMarkdownEditor(parent, onChange) {
  const editable = new Compartment();
  let readOnly = true;
  let pendingComposition = false;
  let compositionTimer;

  function flush() {
    clearTimeout(compositionTimer);
    if (!pendingComposition) return;
    pendingComposition = false;
    onChange();
  }

  function flushAfterInput() {
    clearTimeout(compositionTimer);
    compositionTimer = setTimeout(flush, 0);
  }

  const access = () => [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly),
    EditorView.contentAttributes.of({ 'aria-readonly': String(readOnly) })];
  const extensions = [
    history(),
    EditorState.transactionFilter.of((transaction) =>
      transaction.startState.readOnly && transaction.docChanged ? [] : transaction),
    markdown({ base: markdownLanguage, completeHTMLTags: false, pasteURLAsLink: false }),
    syntaxHighlighting(markdownStyle), markdownMarks, EditorView.lineWrapping,
    EditorView.atomicRanges.of((view) => view.plugin(markdownMarks)?.decorations ?? Decoration.none),
    keymap.of([{ key: 'Mod-b', run: formatBold, preventDefault: true }, ...defaultKeymap, ...historyKeymap]),
    EditorView.contentAttributes.of({ 'aria-label': 'メモ本文', tabindex: '0' }),
    placeholder('メモを書く…'),
    EditorView.updateListener.of((update) => {
      if (!update.docChanged) return;
      pendingComposition = true;
      if (!update.view.compositionStarted) flush();
    }),
    // CodeMirror applies final composition mutations before the next task.
    EditorView.domEventObservers({ compositionend: flushAfterInput, blur: flushAfterInput }),
  ];
  const newView = (doc = '') => new EditorView({
    state: EditorState.create({ doc, extensions: [editable.of(access()), ...extensions] }), parent,
  });
  let view = newView();
  return {
    get value() { return view.state.doc.toString(); },
    set value(text) {
      view.destroy();
      clearTimeout(compositionTimer);
      pendingComposition = false;
      view = newView(text);
    },
    set readOnly(value) {
      if (value === readOnly) return;
      readOnly = value;
      view.dispatch({ effects: editable.reconfigure(access()) });
    },
    flush,
  };
}
