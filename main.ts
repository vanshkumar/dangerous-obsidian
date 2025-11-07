import { App, MarkdownView, Notice, Plugin, TFile, Editor, Modal } from "obsidian";
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
  private overlayLevel: number = 0;
  private wiping: boolean = false;
  private handlersAttached: boolean = false;

  onload() {
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
      id: "start",
      name: "Start",
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
      new Notice("Dangerous mode already running.");
      return;
    }
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || !view.file) {
      new Notice("Open a note to start dangerous mode.");
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
    this.statusEl.setText(`Dangerous mode idle: ${(idleCutoffMs / 1000).toFixed(1)}s`);
    this.idleWarnFired = false;
    this.ensureOverlay();
    document.body.classList.add("dangerous-no-select");
    this.startIdleTicker();

    new Notice(`Dangerous mode armed for ${minutes} min. (idle countdown active)`);
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
        new Notice("Dangerous mode: session complete.");
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
        this.statusEl.setText(`Dangerous mode idle: ${(remaining / 1000).toFixed(1)}s`);
      } else {
        this.statusEl.setText(`Dangerous mode idle: 0.0s`);
        void this.handleIdleTimeout();
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
      new Notice("Dangerous mode: idle cutoff — note wiped.");
    } catch (e) {
      console.error(e);
      new Notice("Dangerous mode: failed to wipe note (see console).");
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
          const clearable = view as MarkdownView & {
            setViewData?: (data: string, clear?: boolean) => void;
          };
          clearable.setViewData?.(preservedFrontmatter, true);
        } catch (err) {
          // Best-effort: clearing undo history may not be available on all views
          console.debug("Dangerous mode: could not clear view history", err);
        }
      }
    }

  }

  private ensureOverlay() {
    if (this.overlayEl) return;
    const el = document.createElement("div");
    el.className = "dangerous-overlay";
    document.body.appendChild(el);
    this.overlayEl = el;
    this.overlayLevel = 0;
  }

  private setOverlayProgress(p: number) {
    if (!this.overlayEl) return;
    const level = clamp(Math.round(p * 10), 0, 10);
    if (level === this.overlayLevel) return;
    // Swap progress-* class to avoid inline styles
    this.overlayEl.classList.remove(`progress-${this.overlayLevel}`);
    this.overlayEl.classList.add(`progress-${level}`);
    this.overlayLevel = level;
  }

  private setOverlayVisible(v: boolean) {
    if (!this.overlayEl) return;
    this.overlayEl.classList.toggle("is-visible", v);
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

    for (const evt of ["copy", "cut", "paste"] as const) {
      this.registerDomEvent(document, evt, (e: Event) => {
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

class DurationPickerModal extends Modal {
  private resolved = false;

  constructor(app: App, private onResult: (n: number | null) => void) {
    super(app);
  }

  onOpen() {
    const { contentEl, titleEl } = this;
    contentEl.empty();
    titleEl.setText("Dangerous mode duration");

    const quick = contentEl.createEl("div");
    const quickOpts: Array<{ label: string; minutes: number }> = [
      { label: "5 minutes", minutes: 5 },
      { label: "10 minutes", minutes: 10 },
      { label: "15 minutes", minutes: 15 },
    ];
    for (const opt of quickOpts) {
      const btn = quick.createEl("button", { text: opt.label });
      btn.addEventListener("click", () => this.choose(opt.minutes));
    }

    const customWrap = contentEl.createEl("div");
    const input = customWrap.createEl("input");
    input.type = "number";
    input.placeholder = "Custom minutes (e.g., 5 or 7.5)";
    input.step = "any";
    input.min = String(0.1);
    input.value = "";
    input.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter") this.submit(input);
    });

    const buttons = contentEl.createEl("div", { cls: "modal-button-container" });
    const startBtn = buttons.createEl("button", { text: "Start" });
    const cancelBtn = buttons.createEl("button", { text: "Cancel" });
    startBtn.addEventListener("click", () => this.submit(input));
    cancelBtn.addEventListener("click", () => this.cancel());

    input.focus();
  }

  private choose(minutes: number) {
    this.resolved = true;
    this.onResult(minutes);
    this.close();
  }

  private submit(input: HTMLInputElement) {
    const n = Number(input.value);
    if (!Number.isFinite(n) || n <= 0) {
      new Notice("Invalid duration");
      input.focus();
      input.select();
      return;
    }
    this.resolved = true;
    this.onResult(n);
    this.close();
  }

  private cancel() {
    this.resolved = true;
    this.onResult(null);
    this.close();
  }

  onClose() {
    if (!this.resolved) this.onResult(null);
    this.contentEl.empty();
  }
}

function pickDuration(app: App): Promise<number | null> {
  return new Promise((resolve) => {
    const modal = new DurationPickerModal(app, resolve);
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
