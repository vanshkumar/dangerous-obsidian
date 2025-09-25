import { App, MarkdownView, Notice, Plugin, TFile, SuggestModal, Editor } from "obsidian";
import { EditorView } from "@codemirror/view";

export default class DangerousModePlugin extends Plugin {
  private active: boolean = false;
  private targetFile: TFile | null = null;
  private session: SessionState | null = null;
  private static readonly DEFAULT_IDLE_CUTOFF_MS = 5000;
  private static readonly OVERLAY_DELAY_MS = 2000; // show overlay after 2s idle
  private lastInsertAt: number = 0;
  private idleTicker: number | null = null;
  private statusEl: HTMLElement | null = null;
  private idleWarnFired: boolean = false;
  private overlayEl: HTMLElement | null = null;
  private wiping: boolean = false;
  private handlersAttached: boolean = false;

  async onload() {
    // Capture text insertions via CodeMirror updates
    this.registerEditorExtension(
      EditorView.updateListener.of((update) => {
        if (!this.active || !this.session) return;

        // Only accept insertions in the target note
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view || !view.file || view.file.path !== this.session.targetPath) return;

        if (!update.docChanged) return;

        // Count inserted characters; ignore pure deletions/moves
        let inserted = 0;
        update.changes.iterChanges((_fa, _ta, _fb, _tb, insertedText) => {
          inserted += insertedText.length;
        });
        if (inserted > 0) {
          this.lastInsertAt = Date.now();
          this.idleWarnFired = false; // reset warning if user resumes typing
        }
      })
    );

    this.addCommand({
      id: "dangerous-mode-start",
      name: "Start Dangerous Mode",
      callback: () => this.startSessionFlow(),
    });

    this.attachGlobalGuards();

    // Fallback idle detection via Obsidian's editor-change event
    this.registerEvent(
      this.app.workspace.on("editor-change", (editor: Editor, view?: MarkdownView) => {
        if (!this.active || !this.session) return;
        if (!view?.file || view.file.path !== this.session.targetPath) return;
        // Only treat net positive length changes as insertions
        const newLen = editor.getValue().length;
        const prevLen = this.session.docLength ?? newLen;
        if (newLen > prevLen) {
          this.lastInsertAt = Date.now();
          this.idleWarnFired = false;
        }
        this.session.docLength = newLen;
      })
    );
  }

  onunload() {
    this.endSession();
  }

  private async startSessionFlow() {
    if (this.active) {
      new Notice("Dangerous Mode already running.");
      return;
    }
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || !view.file) {
      new Notice("Open a note to start Dangerous Mode.");
      return;
    }

    const minutes = await pickDuration(this.app);
    if (minutes == null) return; // cancelled or invalid

    const startedAt = Date.now();
    const durationMs = Math.round(minutes * 60_000);
    const endsAt = startedAt + durationMs;
    const idleCutoffMs = DangerousModePlugin.DEFAULT_IDLE_CUTOFF_MS;

    this.active = true;
    this.targetFile = view.file;
    this.session = {
      targetPath: view.file.path,
      startedAt,
      durationMs,
      idleCutoffMs,
      endsAt,
      docLength: view.editor?.getValue().length ?? 0,
    };

    // Initialize idle tracking UI (simple status bar countdown)
    this.lastInsertAt = startedAt;
    this.statusEl = this.addStatusBarItem();
    this.statusEl.setText(`Dangerous idle: ${(idleCutoffMs / 1000).toFixed(1)}s`);
    this.idleWarnFired = false;
    this.ensureOverlay();
    document.body.classList.add("dangerous-no-select");
    this.startIdleTicker();

    new Notice(`Dangerous Mode armed for ${minutes} min. (idle countdown active)`);
  }

  private endSession() {
    this.active = false;
    this.targetFile = null;
    this.session = null;
    if (this.idleTicker != null) {
      window.clearInterval(this.idleTicker);
      this.idleTicker = null;
    }
    if (this.statusEl) {
      this.statusEl.remove();
      this.statusEl = null;
    }
    if (this.overlayEl) {
      this.overlayEl.remove();
      this.overlayEl = null;
    }
    document.body.classList.remove("dangerous-no-select");
  }

  private startIdleTicker() {
    if (!this.session) return;
    const update = () => {
      if (!this.active || !this.session) return;
      const now = Date.now();
      // End-of-session check first
      if (now >= this.session.endsAt) {
        new Notice("Dangerous Mode: session complete.");
        this.endSession();
        return;
      }

      const idleMs = now - this.lastInsertAt;
      const remaining = this.session.idleCutoffMs - idleMs;

      // Overlay only after a delay into idleness
      const overlayDelay = Math.min(
        DangerousModePlugin.OVERLAY_DELAY_MS,
        this.session.idleCutoffMs
      );
      if (idleMs >= overlayDelay) {
        const denom = Math.max(1, this.session.idleCutoffMs - overlayDelay);
        const p = clamp((idleMs - overlayDelay) / denom, 0, 1);
        this.setOverlayVisible(true);
        this.setOverlayProgress(p);
      } else {
        this.setOverlayVisible(false);
        this.setOverlayProgress(0);
      }

      if (!this.statusEl) return;
      if (remaining > 0) {
        this.statusEl.setText(`Dangerous idle: ${(remaining / 1000).toFixed(1)}s`);
      } else {
        this.statusEl.setText(`Dangerous idle: 0.0s`);
        this.handleIdleTimeout();
      }
    };
    // Update 10 times per second for smoothness
    this.idleTicker = window.setInterval(update, 100);
    // Ensure Obsidian cleans this up with the plugin lifecycle
    this.registerInterval(this.idleTicker);
    update();
  }

  private async handleIdleTimeout() {
    if (!this.active || this.wiping) return;
    this.wiping = true;
    try {
      await this.wipeTargetNote();
      new Notice("Dangerous Mode: idle cutoff — note wiped.");
    } catch (e) {
      console.error(e);
      new Notice("Dangerous Mode: failed to wipe note (see console)");
    } finally {
      this.endSession();
      this.wiping = false;
    }
  }

  private async wipeTargetNote() {
    if (!this.session) return;
    const file = this.app.vault.getAbstractFileByPath(this.session.targetPath);
    if (!file || !(file instanceof TFile)) return;

    // Read and preserve YAML frontmatter (if present)
    const raw = await this.app.vault.read(file);
    const preservedFrontmatter = extractFrontmatterBlock(raw) ?? "";

    // Persist preserved frontmatter only
    await this.app.vault.modify(file, preservedFrontmatter);

    // Clear open views for this file and drop history if possible
    const leaves = this.app.workspace.getLeavesOfType("markdown");
    for (const leaf of leaves) {
      const view = leaf.view as unknown as MarkdownView;
      if (view?.file?.path === this.session.targetPath) {
        try {
          // setViewData(data, clear) clears undo history when clear=true
          (view as any).setViewData?.(preservedFrontmatter, true);
        } catch {}
      }
    }

  }

  private ensureOverlay() {
    if (this.overlayEl) return;
    const el = document.createElement("div");
    el.className = "dangerous-overlay";
    el.style.setProperty("--danger-progress", "0");
    el.style.display = "none";
    document.body.appendChild(el);
    this.overlayEl = el;
  }

  private setOverlayProgress(p: number) {
    if (!this.overlayEl) return;
    this.overlayEl.style.setProperty("--danger-progress", p.toFixed(3));
  }

  private setOverlayVisible(v: boolean) {
    if (!this.overlayEl) return;
    this.overlayEl.style.display = v ? "" : "none";
  }

  // Attach once; handlers check this.active
  // Blocks copy/cut/paste/select-all/undo/redo/context menu and selection initiation
  // while Dangerous Mode is active.
  private attachGlobalGuards() {
    if (this.handlersAttached) return;
    this.handlersAttached = true;

    this.registerDomEvent(document, "keydown", (e: KeyboardEvent) => {
      if (!this.active) return;
      const mod = isMod(e);
      if (
        (mod && (keyEq(e, "c") || keyEq(e, "x") || keyEq(e, "v") || keyEq(e, "a") || keyEq(e, "z") || keyEq(e, "y"))) ||
        (e.shiftKey && mod && keyEq(e, "z"))
      ) {
        e.preventDefault();
        e.stopPropagation();
      }
    }, true);

    for (const evt of ["copy", "cut", "paste"]) {
      this.registerDomEvent(document, evt as any, (e: Event) => {
        if (!this.active) return;
        e.preventDefault();
        e.stopPropagation();
      }, true);
    }

    // Block right-click context menu
    this.registerDomEvent(document, "contextmenu", (e: MouseEvent) => {
      if (!this.active) return;
      e.preventDefault();
      e.stopPropagation();
    }, true);

    // Prevent selection start (mouse/touch)
    this.registerDomEvent(document, "selectstart", (e: Event) => {
      if (!this.active) return;
      e.preventDefault();
      e.stopPropagation();
    }, true);

    // Block drag-drop text insertion
    this.registerDomEvent(document, "dragover", (e: DragEvent) => {
      if (!this.active) return;
      e.preventDefault();
    }, true);
    this.registerDomEvent(document, "drop", (e: DragEvent) => {
      if (!this.active) return;
      e.preventDefault();
      e.stopPropagation();
    }, true);
  }
}

interface SessionState {
  targetPath: string;
  startedAt: number;
  durationMs: number;
  idleCutoffMs: number;
  endsAt: number;
  docLength: number;
}

type DurationItem = { label: string; minutes: number | "custom" };

class DurationModal extends SuggestModal<DurationItem> {
  private items: DurationItem[] = [
    { label: "5 minutes", minutes: 5 },
    { label: "10 minutes", minutes: 10 },
    { label: "15 minutes", minutes: 15 },
    { label: "Custom…", minutes: "custom" },
  ];

  constructor(app: App, private resolve: (m: number | null) => void) {
    super(app);
    this.setPlaceholder("Select Dangerous Mode duration");
    this.limit = 4;
  }

  getSuggestions(query: string): DurationItem[] {
    const q = query.toLowerCase();
    return this.items.filter((i) => i.label.toLowerCase().includes(q));
  }

  renderSuggestion(value: DurationItem, el: HTMLElement) {
    el.createEl("div", { text: value.label });
  }

  onChooseSuggestion(item: DurationItem) {
    if (item.minutes === "custom") {
      const raw = window.prompt("Enter duration in minutes", "5");
      if (raw == null) {
        this.resolve(null);
        return;
      }
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0) {
        new Notice("Invalid duration");
        this.resolve(null);
        return;
      }
      this.resolve(n);
    } else {
      this.resolve(item.minutes);
    }
  }
}

function pickDuration(app: App): Promise<number | null> {
  return new Promise((resolve) => {
    const modal = new DurationModal(app, resolve);
    modal.open();
  });
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

// (clipboard clearing removed by request)

// Extracts YAML frontmatter block (including closing delimiter and a trailing newline)
// when it appears at the very start of the file. Returns null if no frontmatter.
function extractFrontmatterBlock(text: string): string | null {
  // Normalize to \n for scanning; preserve original block content via line joins.
  const lines = text.split(/\r?\n/);
  if (lines.length === 0) return null;
  if (lines[0].trim() !== "---") return null;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      // Include lines[0..i]
      let block = lines.slice(0, i + 1).join("\n");
      // Ensure a single trailing newline after the closing delimiter
      if (!block.endsWith("\n")) block += "\n";
      return block;
    }
  }
  return null;
}

function isMod(e: KeyboardEvent) {
  return e.metaKey || e.ctrlKey;
}

function keyEq(e: KeyboardEvent, char: string) {
  return e.key.toLowerCase() === char.toLowerCase();
}

// helpers
