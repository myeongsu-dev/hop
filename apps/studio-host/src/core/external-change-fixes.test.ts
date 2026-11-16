import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashBytes } from './chunked-fs';
import { setupDesktopEvents } from './desktop-events';
import { TauriBridge } from './tauri-bridge';

const passwordPrompt = vi.hoisted(() => vi.fn());
vi.mock('@/upstream/ui', () => ({ showHwpPasswordDialog: passwordPrompt }));

const externalChangeDialogMock = vi.hoisted(() => vi.fn());
vi.mock('../ui/external-change-dialog', () => ({
  openExternalChangeDialog: externalChangeDialogMock,
}));

const invokeMock = vi.hoisted(() => vi.fn());
const saveMock = vi.hoisted(() => vi.fn());
const openMock = vi.hoisted(() => vi.fn());
const messageMock = vi.hoisted(() => vi.fn());
const fsOpenMock = vi.hoisted(() => vi.fn());
const statMock = vi.hoisted(() => vi.fn());
const removeMock = vi.hoisted(() => vi.fn());
const setTitleMock = vi.hoisted(() => vi.fn());
const tauriListen = vi.hoisted(() => vi.fn());
const currentWindow = vi.hoisted(() => ({
  listen: vi.fn(),
  onCloseRequested: vi.fn(),
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ setTitle: setTitleMock }),
}));

vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: () => currentWindow,
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: tauriListen,
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: openMock,
  save: saveMock,
  message: messageMock,
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  open: fsOpenMock,
  stat: statMock,
  remove: removeMock,
}));

vi.mock('@/core/bridge-factory', () => ({
  isTauriRuntime: () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window,
}));

vi.mock('@/core/wasm-bridge', () => ({
  WasmBridge: class {
    fileName = 'document.hwp';
    loadDocumentMock = vi.fn((_bytes: Uint8Array, fileName: string) => ({
      pageCount: fileName.endsWith('.hwpx') ? 3 : 2,
      fontsUsed: [],
    }));
    createNewDocumentMock = vi.fn(() => ({ pageCount: 1, fontsUsed: [] }));
    exportHwpMock = vi.fn(() => new Uint8Array([1, 2, 3]));
    sourceFormat = 'hwp';
    requiresPasswordForSave = false;

    loadDocument(bytes: Uint8Array, fileName: string) {
      this.sourceFormat = fileName.endsWith('.hwpx') || bytes[0] === 0x50 ? 'hwpx' : 'hwp';
      return this.loadDocumentMock(bytes, fileName);
    }

    createNewDocument() {
      return this.createNewDocumentMock();
    }

    exportHwp() {
      return this.exportHwpMock();
    }

    getSourceFormat() {
      return this.sourceFormat;
    }
  },
}));

describe('external change fixes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setTitleMock.mockReset().mockResolvedValue(undefined);
    statMock.mockResolvedValue({
      size: 3,
      isFile: true,
      mtime: new Date('2026-04-23T00:00:00.000Z'),
    });
    removeMock.mockResolvedValue(undefined);
    tauriListen.mockReset();
    currentWindow.listen.mockReset();
    currentWindow.onCloseRequested.mockReset();
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { document?: unknown }).document;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('drains pendingExternalChange after withDocumentOperation finishes and emits desktop-document-loaded', async () => {
    const { windowHandlers } = installDesktopEnvironment({ focused: true });
    const bridge = new TauriBridge();
    applyOpenResult(bridge, nativeOpenResult({ docId: 'doc-1', sourcePath: '/tmp/source.hwp' }));

    let resolveOpenDialog!: (value: null) => void;
    openMock.mockReturnValue(new Promise((resolve) => {
      resolveOpenDialog = resolve;
    }));
    externalChangeDialogMock.mockResolvedValue('reload');
    fsOpenMock.mockResolvedValue(readHandle([7, 8, 9]));
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'take_pending_open_paths') return [];
      if (command === 'get_update_state') return { status: 'idle' };
      if (command === 'prepare_document_open') return undefined;
      if (command === 'open_document_tracking') {
        return nativeOpenResult({
          docId: 'doc-reloaded',
          fileName: 'source.hwp',
          sourcePath: '/tmp/source.hwp',
          revision: 2,
        });
      }
      if (
        command === 'start_file_watch' ||
        command === 'note_finder_recent_document' ||
        command === 'record_recent_document' ||
        command === 'close_document'
      ) {
        return undefined;
      }
      throw new Error(`unexpected command ${command}`);
    });

    const eventBus = { emit: vi.fn() };
    const setMessage = vi.fn();
    await setupDesktopEvents({
      bridge,
      dispatcher: { dispatch: vi.fn() } as never,
      eventBus: eventBus as never,
      setMessage,
      onUpdateState: vi.fn(),
    });

    const openOp = bridge.openDocumentFromDialog();
    await vi.waitFor(() => expect(openMock).toHaveBeenCalled());

    await windowHandlers.get('hop-external-file-changed')?.({
      payload: { docId: 'doc-1', path: '/tmp/source.hwp', kind: 'modified' },
    });
    expect(externalChangeDialogMock).not.toHaveBeenCalled();

    resolveOpenDialog(null);
    await openOp;

    await vi.waitFor(() =>
      expect(eventBus.emit).toHaveBeenCalledWith(
        'desktop-document-loaded',
        expect.objectContaining({ message: 'source.hwp — 2페이지' }),
      ),
    );
    expect(externalChangeDialogMock).toHaveBeenCalledTimes(1);
    expect(bridge.getCurrentDocId()).toBe('doc-reloaded');
  });

  it('drains direct pendingExternalChange queued during withDocumentOperation when standalone', async () => {
    (globalThis as { document?: { title: string } }).document = { title: '' };
    const bridge = new TauriBridge();
    applyOpenResult(bridge, nativeOpenResult({ docId: 'doc-1', sourcePath: '/tmp/source.hwp' }));

    const onDocumentLoaded = vi.fn();
    bridge.setDesktopListeners({ onDocumentLoaded });

    let resolveOpenDialog!: (value: null) => void;
    openMock.mockReturnValue(new Promise((resolve) => {
      resolveOpenDialog = resolve;
    }));
    externalChangeDialogMock.mockResolvedValue('reload');
    fsOpenMock.mockResolvedValue(readHandle([7, 8, 9]));
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'prepare_document_open') return undefined;
      if (command === 'open_document_tracking') {
        return nativeOpenResult({
          docId: 'doc-reloaded',
          fileName: 'source.hwp',
          sourcePath: '/tmp/source.hwp',
        });
      }
      if (
        command === 'start_file_watch' ||
        command === 'note_finder_recent_document' ||
        command === 'record_recent_document' ||
        command === 'close_document'
      ) {
        return undefined;
      }
      throw new Error(`unexpected command ${command}`);
    });

    const openOp = bridge.openDocumentFromDialog();
    await vi.waitFor(() => expect(openMock).toHaveBeenCalled());

    const queuedResult = await bridge.handleExternalFileChanged({
      docId: 'doc-1',
      path: '/tmp/source.hwp',
      kind: 'modified',
    });
    expect(queuedResult).toBeNull();
    expect(externalChangeDialogMock).not.toHaveBeenCalled();

    resolveOpenDialog(null);
    await openOp;

    await vi.waitFor(() =>
      expect(onDocumentLoaded).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'source.hwp — 2페이지' }),
      ),
    );
  });

  it('does not show deleted status message when deferred deleted event is for a previous docId', async () => {
    const { windowHandlers, focusListeners, setFocused } = installDesktopEnvironment({ focused: false });
    const bridge = new TauriBridge();
    applyOpenResult(bridge, nativeOpenResult({ docId: 'doc-1', sourcePath: '/tmp/doc1.hwp' }));

    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'take_pending_open_paths') return [];
      if (command === 'get_update_state') return { status: 'idle' };
      return undefined;
    });

    const setMessage = vi.fn();
    await setupDesktopEvents({
      bridge,
      dispatcher: { dispatch: vi.fn() } as never,
      eventBus: { emit: vi.fn() } as never,
      setMessage,
      onUpdateState: vi.fn(),
    });

    await windowHandlers.get('hop-external-file-changed')?.({
      payload: { docId: 'doc-1', path: '/tmp/doc1.hwp', kind: 'deleted' },
    });
    expect(setMessage).toHaveBeenCalledWith('외부에서 파일이 변경되었습니다. 창을 선택하면 확인합니다.');
    setMessage.mockClear();

    // Switch to another document before focus returns
    applyOpenResult(bridge, nativeOpenResult({ docId: 'doc-2', sourcePath: '/tmp/doc2.hwp' }));
    setFocused(true);
    for (const listener of focusListeners) {
      listener();
    }
    await Promise.resolve();
    await Promise.resolve();

    expect(externalChangeDialogMock).not.toHaveBeenCalled();
    expect(setMessage).not.toHaveBeenCalledWith('원본 파일이 외부에서 삭제되었거나 이동되었습니다');
  });

  it('blocks menu commands, document operations, and window close while external change modal is open', async () => {
    const { windowHandlers } = installDesktopEnvironment({ focused: true });
    const bridge = new TauriBridge();
    applyOpenResult(bridge, nativeOpenResult({ docId: 'doc-1', sourcePath: '/tmp/source.hwp' }));

    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'take_pending_open_paths') return [];
      if (command === 'get_update_state') return { status: 'idle' };
      if (command === 'acknowledge_external_change') return undefined;
      throw new Error(`unexpected command ${command}`);
    });

    let resolveDialog!: (decision: string) => void;
    externalChangeDialogMock.mockReturnValue(new Promise((resolve) => {
      resolveDialog = resolve;
    }));

    const dispatcher = { dispatch: vi.fn() };
    const setMessage = vi.fn();
    await setupDesktopEvents({
      bridge,
      dispatcher: dispatcher as never,
      eventBus: { emit: vi.fn() } as never,
      setMessage,
      onUpdateState: vi.fn(),
    });

    const externalChangePromise = windowHandlers.get('hop-external-file-changed')?.({
      payload: { docId: 'doc-1', path: '/tmp/source.hwp', kind: 'modified' },
    });
    await vi.waitFor(() => expect(externalChangeDialogMock).toHaveBeenCalledTimes(1));

    // Menu command is blocked while modal is open
    await windowHandlers.get('hop-menu-command')?.({ payload: 'file:save' });
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
    expect(setMessage).toHaveBeenCalledWith('외부 변경 확인 대화상자를 먼저 닫아주세요.');

    // Direct bridge document operations and window close are also blocked
    await expect(bridge.saveDocumentFromCommand()).rejects.toThrow('다른 문서 작업이 진행 중');
    await expect(bridge.openDocumentByPath('/tmp/other.hwp')).rejects.toThrow('다른 문서 작업이 진행 중');
    expect(await bridge.confirmWindowClose()).toBe(false);

    // Resolving modal unblocks operations
    resolveDialog('ignore');
    await externalChangePromise;

    await windowHandlers.get('hop-menu-command')?.({ payload: 'file:save' });
    expect(dispatcher.dispatch).toHaveBeenCalledWith('file:save');
  });

  it('syncs clean state after saving copy and reports copy-saved when reload fails in save-copy-and-reload', async () => {
    (globalThis as { document?: { title: string } }).document = { title: '' };
    const bridge = new TauriBridge();
    applyOpenResult(bridge, nativeOpenResult({ docId: 'doc-dirty', dirty: true }));

    const onDocumentSaved = vi.fn();
    bridge.setDesktopListeners({ onDocumentSaved });

    externalChangeDialogMock.mockResolvedValue('save-copy-and-reload');
    saveMock.mockResolvedValue('/tmp/copy.hwp');
    fsOpenMock.mockResolvedValue(writeHandle());
    statMock.mockResolvedValueOnce({
      size: 3,
      isFile: true,
      mtime: new Date('2026-04-23T00:00:00.000Z'),
    });
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'check_external_modification') return { changed: false };
      if (command === 'prepare_staged_hwp_save') return '/tmp/copy.hwp.tmp';
      if (command === 'commit_staged_hwp_save') {
        return {
          docId: 'doc-dirty',
          sourcePath: '/tmp/copy.hwp',
          format: 'hwp',
          revision: 2,
          dirty: false,
          warnings: [],
        };
      }
      if (command === 'start_file_watch' || command === 'note_finder_recent_document') {
        return undefined;
      }
      if (command === 'prepare_document_open') {
        throw new Error('원본 파일 없음');
      }
      throw new Error(`unexpected command ${command}`);
    });

    await expect(
      bridge.handleExternalFileChanged({
        docId: 'doc-dirty',
        path: '/tmp/source.hwp',
        kind: 'modified',
      }),
    ).rejects.toThrow('사본은 저장됨 (/tmp/copy.hwp), 원본 다시 불러오기 실패: 원본 파일 없음');

    expect(onDocumentSaved).toHaveBeenCalledWith(
      expect.objectContaining({ sourcePath: '/tmp/copy.hwp', dirty: false }),
    );
    expect(bridge.hasUnsavedChanges()).toBe(false);
  });

  it('syncs clean state and notifies copy-saved when reload is cancelled after saving copy', async () => {
    (globalThis as { document?: { title: string } }).document = { title: '' };
    const bridge = new TauriBridge();
    applyOpenResult(bridge, nativeOpenResult({ docId: 'doc-dirty', dirty: true }));

    const onDocumentSaved = vi.fn();
    const onStatus = vi.fn();
    bridge.setDesktopListeners({ onDocumentSaved, onStatus });

    externalChangeDialogMock.mockResolvedValue('save-copy-and-reload');
    saveMock.mockResolvedValue('/tmp/copy.hwp');
    const copyBytes = Uint8Array.from([1, 2, 3]);
    fsOpenMock
      .mockResolvedValueOnce(writeHandle())
      .mockResolvedValueOnce(readHandle(copyBytes));
    passwordPrompt.mockResolvedValue(null);
    const loadDocMock = getWasmMock(bridge, 'loadDocumentMock');
    loadDocMock.mockImplementationOnce(() => {
      throw new Error('비밀번호가 필요한 암호 문서입니다.');
    });

    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'check_external_modification') return { changed: false };
      if (command === 'prepare_staged_hwp_save') return '/tmp/copy.hwp.tmp';
      if (command === 'commit_staged_hwp_save') {
        return {
          docId: 'doc-dirty',
          sourcePath: '/tmp/copy.hwp',
          format: 'hwp',
          revision: 2,
          dirty: false,
          warnings: [],
        };
      }
      if (command === 'prepare_document_open') return undefined;
      if (command === 'open_document_tracking') {
        return nativeOpenResult({
          docId: 'doc-candidate',
          fileName: 'source.hwp',
          sourcePath: '/tmp/source.hwp',
        });
      }
      if (
        command === 'start_file_watch' ||
        command === 'note_finder_recent_document' ||
        command === 'close_document'
      ) {
        return undefined;
      }
      throw new Error(`unexpected command ${command}`);
    });

    const result = await bridge.handleExternalFileChanged({
      docId: 'doc-dirty',
      path: '/tmp/source.hwp',
      kind: 'modified',
    });

    expect(result).toBeNull();
    expect(onDocumentSaved).toHaveBeenCalledWith(
      expect.objectContaining({ sourcePath: '/tmp/copy.hwp', dirty: false }),
    );
    expect(bridge.hasUnsavedChanges()).toBe(false);
    expect(onStatus).toHaveBeenCalledWith(
      '사본은 저장됨 (/tmp/copy.hwp), 원본 다시 불러오기가 취소되었습니다.',
    );
    expect(hashBytes(copyBytes)).toBeTypeOf('number');
  });
});

function installDesktopEnvironment({ focused }: { focused: boolean }) {
  const windowHandlers = new Map<string, (event: { payload: unknown }) => unknown>();
  const focusListeners: Array<() => void> = [];
  let isFocused = focused;

  tauriListen.mockImplementation(async () => vi.fn());
  currentWindow.listen.mockImplementation(
    async (name: string, handler: (event: { payload: unknown }) => unknown) => {
      windowHandlers.set(name, handler);
      return vi.fn();
    },
  );
  currentWindow.onCloseRequested.mockImplementation(async () => vi.fn());

  (globalThis as { window?: unknown }).window = {
    __TAURI_INTERNALS__: {},
    addEventListener: (event: string, listener: () => void) => {
      if (event === 'focus') focusListeners.push(listener);
    },
  };
  (globalThis as { document?: unknown }).document = {
    title: '',
    hasFocus: () => isFocused,
    getElementById: () => null,
  };

  return {
    windowHandlers,
    focusListeners,
    setFocused: (next: boolean) => {
      isFocused = next;
    },
  };
}

function readHandle(bytes: ArrayLike<number>) {
  const data = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  let offset = 0;
  return {
    read: vi.fn(async (buffer: Uint8Array) => {
      if (offset >= data.length) return null;
      const count = Math.min(buffer.byteLength, data.length - offset);
      buffer.set(data.subarray(offset, offset + count));
      offset += count;
      return count;
    }),
    close: vi.fn(async () => undefined),
  };
}

function writeHandle() {
  return {
    write: vi.fn(async (bytes: Uint8Array) => bytes.byteLength),
    close: vi.fn(async () => undefined),
  };
}

function applyOpenResult(bridge: TauriBridge, result: Record<string, unknown>) {
  (bridge as unknown as { applyNativeOpenResult(result: Record<string, unknown>): void })
    .applyNativeOpenResult(result);
}

function nativeOpenResult(overrides: Record<string, unknown> = {}) {
  return {
    docId: 'doc-1',
    fileName: 'source.hwp',
    sourcePath: '/tmp/source.hwp',
    format: 'hwp',
    pageCount: 1,
    revision: 1,
    dirty: false,
    warnings: [],
    ...overrides,
  };
}

function getWasmMock(
  bridge: TauriBridge,
  name: 'loadDocumentMock' | 'createNewDocumentMock' | 'exportHwpMock',
) {
  return (bridge as unknown as Record<typeof name, ReturnType<typeof vi.fn>>)[name];
}
