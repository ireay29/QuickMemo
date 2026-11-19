const preferenceKey = 'quickmemo-note-list-height';

function readPreference() {
  try {
    const value = localStorage.getItem(preferenceKey);
    const height = Number(value);
    if (value !== null && Number.isFinite(height) && height >= 0) return height;
  } catch (error) {
    console.warn('一覧の高さを読み込めませんでした。', error);
  }
}

function mountSplitter() {
  const separator = document.getElementById('list-splitter');
  const pane = document.getElementById('note-list-pane');
  const library = pane.closest('.library');
  const main = separator.closest('main');
  const editor = main.querySelector('.editor');
  const minimum = parseFloat(getComputedStyle(pane).minHeight);
  let preferredHeight = readPreference();
  let maximum = minimum;
  let drag;

  const clamp = (height) => Math.min(maximum, Math.max(minimum, Math.round(height)));

  function updateLayout() {
    const controlsHeight = library.getBoundingClientRect().height - pane.getBoundingClientRect().height;
    const editorMinimum = parseFloat(getComputedStyle(editor).minHeight);
    maximum = Math.max(minimum, Math.floor(main.clientHeight - controlsHeight - separator.offsetHeight - editorMinimum));
    pane.style.setProperty('--notes-space', `${maximum}px`);
    if (preferredHeight === undefined) pane.style.removeProperty('--notes-height');
    else pane.style.setProperty('--notes-height', `${clamp(preferredHeight)}px`);

    const height = Math.round(pane.getBoundingClientRect().height);
    separator.setAttribute('aria-valuemin', String(minimum));
    separator.setAttribute('aria-valuemax', String(maximum));
    separator.setAttribute('aria-valuenow', String(height));
    separator.setAttribute('aria-disabled', String(minimum === maximum));
  }

  function rememberHeight() {
    try {
      localStorage.setItem(preferenceKey, String(preferredHeight));
    } catch (error) {
      console.warn('一覧の高さを保存できませんでした。', error);
    }
  }

  function moveTo(clientY) {
    const height = clamp(drag.startHeight + clientY - drag.startY);
    if (height !== Math.round(pane.getBoundingClientRect().height)) {
      preferredHeight = height;
      updateLayout();
    }
  }

  separator.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || !event.isPrimary || drag || minimum === maximum) return;
    event.preventDefault();
    separator.focus({ preventScroll: true });
    separator.setPointerCapture(event.pointerId);
    drag = { id: event.pointerId, startY: event.clientY,
      startHeight: pane.getBoundingClientRect().height, previousHeight: preferredHeight };
    separator.classList.add('dragging');
  });
  separator.addEventListener('pointermove', (event) => {
    if (drag?.id === event.pointerId) moveTo(event.clientY);
  });
  separator.addEventListener('pointerup', (event) => {
    if (drag?.id !== event.pointerId) return;
    if (event.clientY !== drag.startY || preferredHeight !== drag.previousHeight) moveTo(event.clientY);
    if (preferredHeight !== drag.previousHeight) rememberHeight();
    drag = undefined;
    separator.classList.remove('dragging');
  });
  function cancelDrag(event) {
    if (drag?.id !== event.pointerId) return;
    preferredHeight = drag.previousHeight;
    drag = undefined;
    separator.classList.remove('dragging');
    updateLayout();
  }
  separator.addEventListener('pointercancel', cancelDrag);
  separator.addEventListener('lostpointercapture', cancelDrag);

  separator.addEventListener('keydown', (event) => {
    if (drag || minimum === maximum) return;
    const height = Math.round(pane.getBoundingClientRect().height);
    const target = { ArrowUp: height - 24, ArrowDown: height + 24, Home: minimum, End: maximum }[event.key];
    if (typeof target !== 'number') return;
    event.preventDefault();
    if (clamp(target) === height) return;
    preferredHeight = clamp(target);
    updateLayout();
    rememberHeight();
  });

  const observer = new ResizeObserver(updateLayout);
  observer.observe(main);
  observer.observe(library);
  updateLayout();
}

if (!new URLSearchParams(location.search).has('settings')) mountSplitter();
