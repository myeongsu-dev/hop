import type { CommandDispatcher } from '@/upstream/commands';
import type { EventBus } from '@/upstream/core';
import { isTauriRuntime } from '@/core/bridge-factory';
import { findLatestSupportedDocumentPath, hasSupportedDocumentPath } from '@/core/document-files';
import type {
  DesktopBridgeApi,
  DesktopLoadPayload,
  DesktopUpdateState,
  ExternalFileChangedPayload,
} from './tauri-bridge';

type DesktopRuntimeBridge = Partial<
  Pick<
    DesktopBridgeApi,
    | 'openDocumentByPath'
    | 'handleExternalFileChanged'
    | 'getCurrentDocId'
    | 'isDocumentOperationPending'
    | 'isExternalChangeInFlight'
    | 'setDesktopListeners'
    | 'takePendingOpenPaths'
    | 'createNewDocumentAsync'
    | 'confirmWindowClose'
    | 'destroyCurrentWindow'
    | 'cancelAppQuit'
    | 'hasUnsavedChanges'
    | 'getUpdateState'
  >
>;

interface DesktopEventsOptions {
  bridge: unknown;
  dispatcher: CommandDispatcher;
  eventBus: EventBus;
  setMessage(message: string): void;
  onUpdateState(state: DesktopUpdateState): void;
}

interface CloseRequestEvent {
  preventDefault(): void;
}

export async function setupDesktopEvents({
  bridge,
  dispatcher,
  eventBus,
  setMessage,
  onUpdateState,
}: DesktopEventsOptions): Promise<void> {
  if (!isTauriRuntime()) return;

  const desktop = bridge as DesktopRuntimeBridge;
  const { listen } = await import('@tauri-apps/api/event');
  const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow');
  const currentWindow = getCurrentWebviewWindow();

  await listen('hop-job-progress', (event) => {
    const payload = event.payload as { message?: string };
    if (payload?.message) setMessage(payload.message);
  });

  await listen('hop-update-state', (event) => {
    onUpdateState(event.payload as DesktopUpdateState);
  });

  let deferredExternalChange: ExternalFileChangedPayload | null = null;
  let processingExternalChange = false;

  const hasWindowFocus = (): boolean =>
    typeof document === 'undefined' ||
    typeof document.hasFocus !== 'function' ||
    document.hasFocus();

  await currentWindow.listen('hop-menu-command', (event) => {
    const command = String(event.payload || '');
    if (!command) return;
    if (processingExternalChange || desktop.isExternalChangeInFlight?.()) {
      setMessage('외부 변경 확인 대화상자를 먼저 닫아주세요.');
      return;
    }
    dispatcher.dispatch(command);
  });

  await currentWindow.listen('hop-app-quit-requested', async () => {
    await handleDesktopAppQuitRequest(desktop, setMessage);
  });

  await currentWindow.listen('hop-open-paths', async (event) => {
    const payload = event.payload as { paths?: string[] };
    const pending = await desktop.takePendingOpenPaths?.();
    await openLatestDesktopDocument({
      bridge: desktop,
      eventBus,
      paths: [...(payload.paths ?? []), ...(pending ?? [])],
      setMessage,
    });
  });

  const drainDeferredExternalChange = async (): Promise<void> => {
    const queued = deferredExternalChange;
    if (
      !queued ||
      processingExternalChange ||
      desktop.isDocumentOperationPending?.() ||
      !hasWindowFocus()
    ) {
      return;
    }
    deferredExternalChange = null;
    await processExternalChange(queued);
  };

  const processExternalChange = async (payload: ExternalFileChangedPayload): Promise<void> => {
    if (!desktop.handleExternalFileChanged) return;
    if (processingExternalChange || desktop.isDocumentOperationPending?.()) {
      deferredExternalChange = payload;
      return;
    }
    processingExternalChange = true;
    try {
      const loaded = await desktop.handleExternalFileChanged(payload);
      if (loaded) {
        eventBus.emit('desktop-document-loaded', loaded);
        setMessage(loaded.message);
      } else if (
        payload.kind === 'deleted' &&
        (!desktop.getCurrentDocId || desktop.getCurrentDocId() === payload.docId)
      ) {
        setMessage('원본 파일이 외부에서 삭제되었거나 이동되었습니다');
      }
    } catch (error) {
      setMessage(`외부 변경 처리 실패: ${error}`);
      console.error('[desktop-events] 외부 변경 처리 실패:', error);
    } finally {
      processingExternalChange = false;
      await drainDeferredExternalChange();
    }
  };

  desktop.setDesktopListeners?.({
    onDocumentLoaded: (loaded) => {
      eventBus.emit('desktop-document-loaded', loaded);
      setMessage(loaded.message);
    },
    onDocumentSaved: (saved) => {
      eventBus.emit('desktop-document-saved', saved);
    },
    onDocumentOperationSettled: () => {
      void drainDeferredExternalChange();
    },
    onExternalFileDeleted: (payload) => {
      if (!desktop.getCurrentDocId || desktop.getCurrentDocId() === payload.docId) {
        setMessage('원본 파일이 외부에서 삭제되었거나 이동되었습니다');
      }
    },
    onStatus: (message) => {
      setMessage(message);
    },
  });

  await currentWindow.listen('hop-external-file-changed', async (event) => {
    const payload = event.payload as ExternalFileChangedPayload;
    if (!payload?.docId || !payload?.path) return;
    if (!hasWindowFocus()) {
      deferredExternalChange = payload;
      setMessage('외부에서 파일이 변경되었습니다. 창을 선택하면 확인합니다.');
      return;
    }
    await processExternalChange(payload);
  });

  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('focus', () => {
      void drainDeferredExternalChange();
    });
  }

  await currentWindow.listen('tauri://drag-enter', (event) => {
    const payload = event.payload as { paths?: string[] };
    if (hasSupportedDocumentPath(payload.paths ?? [])) {
      setDesktopDragActive(true);
      setMessage('HWP/HWPX 파일을 놓으면 문서를 엽니다');
    }
  });

  await currentWindow.listen('tauri://drag-leave', () => {
    setDesktopDragActive(false);
  });

  await currentWindow.listen('tauri://drag-drop', () => {
    setDesktopDragActive(false);
  });

  await currentWindow.onCloseRequested(async (event) => {
    await handleDesktopCloseRequest(event, desktop, setMessage);
  });

  const pending = await desktop.takePendingOpenPaths?.();
  await openLatestDesktopDocument({
    bridge: desktop,
    eventBus,
    paths: pending ?? [],
    setMessage,
  });

  if (desktop.getUpdateState) {
    try {
      onUpdateState(await desktop.getUpdateState());
    } catch (error) {
      console.warn('[desktop-events] updater state hydrate failed:', error);
    }
  }
}

export async function createDesktopDocument(bridge: unknown): Promise<DesktopLoadPayload | null> {
  const desktop = bridge as DesktopRuntimeBridge;
  if (!desktop.createNewDocumentAsync) return null;
  return desktop.createNewDocumentAsync();
}

async function handleDesktopCloseRequest(
  event: CloseRequestEvent,
  desktop: DesktopRuntimeBridge,
  setMessage: (message: string) => void,
): Promise<void> {
  if (!desktop.destroyCurrentWindow) return;
  event.preventDefault();
  await confirmAndDestroyWindow(desktop, {
    context: 'close request',
    errorPrefix: '창 닫기 실패',
    setMessage,
  });
}

async function handleDesktopAppQuitRequest(
  desktop: DesktopRuntimeBridge,
  setMessage: (message: string) => void,
): Promise<void> {
  if (!desktop.destroyCurrentWindow) return;
  await confirmAndDestroyWindow(desktop, {
    context: 'app quit request',
    errorPrefix: '앱 종료 실패',
    onCancel: () => desktop.cancelAppQuit?.(),
    setMessage,
  });
}

function setDesktopDragActive(active: boolean): void {
  document.getElementById('scroll-container')?.classList.toggle('drag-over', active);
}

async function confirmAndDestroyWindow(
  desktop: DesktopRuntimeBridge,
  {
    context,
    errorPrefix,
    onCancel,
    setMessage,
  }: {
    context: string;
    errorPrefix: string;
    onCancel?: () => Promise<void> | void;
    setMessage: (message: string) => void;
  },
): Promise<void> {
  if (!desktop.destroyCurrentWindow) return;

  try {
    const canClose = desktop.confirmWindowClose ? await desktop.confirmWindowClose() : true;
    if (canClose) {
      await desktop.destroyCurrentWindow();
    } else {
      await onCancel?.();
    }
  } catch (error) {
    console.error(`[desktop-events] ${context} failed:`, error);
    if (!desktop.hasUnsavedChanges?.()) {
      await desktop.destroyCurrentWindow();
    } else {
      setMessage(`${errorPrefix}: ${error}`);
      await onCancel?.();
    }
  }
}

async function openLatestDesktopDocument({
  bridge,
  eventBus,
  paths,
  setMessage,
}: {
  bridge: DesktopRuntimeBridge;
  eventBus: EventBus;
  paths: string[];
  setMessage(message: string): void;
}): Promise<void> {
  const path = findLatestSupportedDocumentPath(paths);
  if (!path) {
    if (paths.length > 0) setMessage('HWP/HWPX 파일만 열 수 있습니다');
    return;
  }
  if (!bridge.openDocumentByPath) return;

  try {
    setMessage('파일 로딩 중...');
    const loaded = await bridge.openDocumentByPath(path);
    if (loaded) eventBus.emit('desktop-document-loaded', loaded);
  } catch (error) {
    const errMsg = `파일 로드 실패: ${error}`;
    setMessage(errMsg);
    console.error('[desktop-events] 데스크톱 파일 로드 실패:', error);
  }
}
