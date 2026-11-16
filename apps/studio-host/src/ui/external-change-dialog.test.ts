import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openExternalChangeDialog } from './external-change-dialog';

type EventListener = (event: { target?: unknown; key?: string; stopPropagation(): void; preventDefault(): void }) => void;

class FakeElement {
  className = '';
  textContent = '';
  type = '';
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  children: FakeElement[] = [];
  removed = false;
  focused = false;
  private classes = new Set<string>();
  classList = {
    add: (...names: string[]) => {
      names.forEach((name) => this.classes.add(name));
    },
    contains: (name: string) => this.classes.has(name),
  };
  private listeners = new Map<string, EventListener[]>();

  setAttribute(): void {}

  append(...children: FakeElement[]): void {
    this.children.push(...children);
  }

  appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    return child;
  }

  addEventListener(type: string, listener: EventListener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  click(): void {
    this.listeners.get('click')?.forEach((listener) => {
      listener({ target: this, stopPropagation: () => undefined, preventDefault: () => undefined });
    });
  }

  focus(): void {
    this.focused = true;
  }

  remove(): void {
    this.removed = true;
  }
}

class FakeDocument {
  body = new FakeElement();
  private listeners = new Map<string, EventListener[]>();

  createElement(): FakeElement {
    return new FakeElement();
  }

  addEventListener(type: string, listener: EventListener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, listener: EventListener): void {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      list.filter((item) => item !== listener),
    );
  }

  dispatchKey(key: string): void {
    this.listeners.get('keydown')?.forEach((listener) => {
      listener({ key, stopPropagation: () => undefined, preventDefault: () => undefined });
    });
  }
}

function collectButtons(root: FakeElement): FakeElement[] {
  const buttons: FakeElement[] = [];
  for (const child of root.children) {
    if (child.dataset.decision) {
      buttons.push(child);
    }
    buttons.push(...collectButtons(child));
  }
  return buttons;
}

describe('openExternalChangeDialog', () => {
  let fakeDocument: FakeDocument;

  beforeEach(() => {
    fakeDocument = new FakeDocument();
    (globalThis as { document?: Document }).document = fakeDocument as unknown as Document;
  });

  afterEach(() => {
    delete (globalThis as { document?: Document }).document;
  });

  it('renders 2 choices when document is clean and resolves clicked decision', async () => {
    const promise = openExternalChangeDialog({
      fileName: 'doc.hwp',
      path: 'C:\\docs\\doc.hwp',
      dirty: false,
      kind: 'modified',
    });

    const overlay = fakeDocument.body.children[0]!;
    const buttons = collectButtons(overlay);
    expect(buttons.map((b) => b.dataset.decision)).toEqual(['reload', 'ignore']);
    expect(buttons[0]?.focused).toBe(true);

    buttons[0]!.click();
    await expect(promise).resolves.toBe('reload');
    expect(overlay.removed).toBe(true);
  });

  it('dismisses clean dialog as ignore on Escape', async () => {
    const promise = openExternalChangeDialog({
      fileName: 'doc.hwp',
      path: 'C:\\docs\\doc.hwp',
      dirty: false,
      kind: 'modified',
    });

    fakeDocument.dispatchKey('Escape');
    await expect(promise).resolves.toBe('ignore');
  });

  it.each([
    ['reload-discard', 0],
    ['save-copy-and-reload', 1],
    ['keep-mine', 2],
  ] as const)('renders 3-way choices when dirty and resolves %s', async (decision, index) => {
    const promise = openExternalChangeDialog({
      fileName: 'dirty.hwp',
      path: 'C:\\docs\\dirty.hwp',
      dirty: true,
      kind: 'modified',
    });

    const overlay = fakeDocument.body.children[0]!;
    const buttons = collectButtons(overlay);
    expect(buttons.map((b) => b.dataset.decision)).toEqual([
      'reload-discard',
      'save-copy-and-reload',
      'keep-mine',
    ]);
    expect(buttons[1]?.focused).toBe(true);

    buttons[index]!.click();
    await expect(promise).resolves.toBe(decision);
  });

  it('dismisses dirty dialog as keep-mine on Escape', async () => {
    const promise = openExternalChangeDialog({
      fileName: 'dirty.hwp',
      path: 'C:\\docs\\dirty.hwp',
      dirty: true,
      kind: 'modified',
    });

    fakeDocument.dispatchKey('Escape');
    await expect(promise).resolves.toBe('keep-mine');
  });

  it('renders single acknowledge button when file is deleted', async () => {
    const promise = openExternalChangeDialog({
      fileName: 'deleted.hwp',
      path: 'C:\\docs\\deleted.hwp',
      dirty: true,
      kind: 'deleted',
    });

    const overlay = fakeDocument.body.children[0]!;
    const buttons = collectButtons(overlay);
    expect(buttons.map((b) => b.dataset.decision)).toEqual(['acknowledge-deleted']);

    buttons[0]!.click();
    await expect(promise).resolves.toBe('acknowledge-deleted');
  });
});
