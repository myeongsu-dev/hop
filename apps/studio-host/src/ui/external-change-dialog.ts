export type ExternalChangeKind = 'modified' | 'deleted';

export type ExternalChangeDecision =
  | 'reload'
  | 'ignore'
  | 'reload-discard'
  | 'keep-mine'
  | 'save-copy-and-reload'
  | 'acknowledge-deleted';

export interface ExternalChangeDialogOptions {
  fileName: string;
  path: string;
  dirty: boolean;
  kind: ExternalChangeKind;
}

export function openExternalChangeDialog(
  options: ExternalChangeDialogOptions,
): Promise<ExternalChangeDecision> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'dialog-wrap external-change-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.style.width = '480px';

    const titleBar = document.createElement('div');
    titleBar.className = 'dialog-title';
    titleBar.textContent =
      options.kind === 'deleted' ? '원본 파일 삭제/이동 감지' : '외부 변경 감지';

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'dialog-close';
    closeBtn.textContent = '\u00D7';
    titleBar.appendChild(closeBtn);

    const body = document.createElement('div');
    body.className = 'dialog-body external-change-body';

    const message = document.createElement('p');
    message.className = 'external-change-message';
    if (options.kind === 'deleted') {
      message.textContent =
        '열린 파일이 외부에서 삭제되었거나 이동되었습니다. 현재 편집 내용을 보존하려면 다른 이름으로 저장하세요.';
    } else if (options.dirty) {
      message.textContent =
        '외부 프로그램이 파일을 수정했습니다. 저장하지 않은 변경 사항이 있습니다.';
    } else {
      message.textContent =
        '외부 프로그램이 파일을 수정했습니다. 다시 불러오시겠습니까?';
    }

    const fileMeta = document.createElement('div');
    fileMeta.className = 'external-change-path';
    fileMeta.textContent = options.path || options.fileName;

    body.append(message, fileMeta);

    const footer = document.createElement('div');
    footer.className = 'dialog-footer external-change-footer';

    const defaultDismiss: ExternalChangeDecision =
      options.kind === 'deleted'
        ? 'acknowledge-deleted'
        : options.dirty
          ? 'keep-mine'
          : 'ignore';

    const close = (decision: ExternalChangeDecision) => {
      document.removeEventListener('keydown', onKeyDown, true);
      overlay.remove();
      resolve(decision);
    };

    const addButton = (
      label: string,
      decision: ExternalChangeDecision,
      variant: 'primary' | 'danger' | 'default' = 'default',
    ): HTMLButtonElement => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'dialog-btn';
      if (variant === 'primary') btn.classList.add('dialog-btn-primary');
      if (variant === 'danger') btn.classList.add('external-change-btn-danger');
      btn.textContent = label;
      btn.dataset.decision = decision;
      btn.addEventListener('click', () => close(decision));
      footer.appendChild(btn);
      return btn;
    };

    let focusBtn: HTMLButtonElement;
    if (options.kind === 'deleted') {
      focusBtn = addButton('확인', 'acknowledge-deleted', 'primary');
    } else if (options.dirty) {
      addButton('외부 변경 불러오기(내 편집 버림)', 'reload-discard', 'danger');
      focusBtn = addButton('내 편집을 사본으로 저장 후 불러오기', 'save-copy-and-reload', 'primary');
      addButton('내 편집 유지', 'keep-mine');
    } else {
      focusBtn = addButton('다시 불러오기', 'reload', 'primary');
      addButton('무시', 'ignore');
    }

    const onKeyDown = (event: KeyboardEvent) => {
      event.stopPropagation();
      if (event.key === 'Escape') {
        event.preventDefault();
        close(defaultDismiss);
      }
    };

    closeBtn.addEventListener('click', () => close(defaultDismiss));
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) close(defaultDismiss);
    });

    dialog.append(titleBar, body, footer);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKeyDown, true);
    focusBtn.focus?.();
  });
}
