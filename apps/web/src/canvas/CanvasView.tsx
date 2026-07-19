import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  forwardRef,
  type DragEvent,
} from 'react';
import { WarningCircle, X } from '@phosphor-icons/react';
import type { ComponentRegistry } from '@epagoge/components';
import { createEditor, type EditorHandle, type ConnectionRejection } from './editor.js';
import type { ArchitectureNode } from './nodes.js';
import { PALETTE_DRAG_MIME } from './ComponentPalette.js';

interface Props {
  registry: ComponentRegistry;
  onReady: (handle: EditorHandle) => void;
  onSelectionChange: (node: ArchitectureNode | null) => void;
  onChange: () => void;
  /** Called when a palette item is dropped onto the canvas. The
   *  receiver should look up the component id, build a node, and
   *  position it at the supplied graph coordinates. */
  onDropComponent: (componentId: string, graphX: number, graphY: number) => void;
}

export interface CanvasViewHandle {
  /** Re-emit current selection + graph state. Useful after hydration. */
  refresh: () => void;
  /** Briefly flash the canvas border mint — acknowledges a chain-signing
   *  moment (architecture save). 700ms animation, see styles.css
   *  `.save-flash`. Pitch Sprint Day 8 wired this up. */
  flashSave: () => void;
}

/**
 * The Rete-mounted React component. Owns the DOM container the editor
 * renders into; on mount it builds the editor, plugs in change +
 * selection listeners, and hands the imperative handle up to the page.
 */
export const CanvasView = forwardRef<CanvasViewHandle, Props>(function CanvasView(
  { registry, onReady, onSelectionChange, onChange, onDropComponent },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<EditorHandle | null>(null);
  const [rejection, setRejection] = useState<ConnectionRejection | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const [saveFlash, setSaveFlash] = useState(false);
  // Drag-counter pattern — onDragLeave fires when entering child elements,
  // so we count enters and only clear when count returns to zero.
  const dragCounter = useRef(0);

  useEffect(() => {
    if (!containerRef.current) return;
    let alive = true;
    let unsubChange: (() => void) | null = null;
    let unsubSel: (() => void) | null = null;
    let unsubRej: (() => void) | null = null;

    (async () => {
      const handle = await createEditor(containerRef.current!, { registry });
      if (!alive) {
        handle.destroy();
        return;
      }
      handleRef.current = handle;
      unsubChange = handle.onChange(onChange);
      unsubSel = handle.onSelectionChange(onSelectionChange);
      unsubRej = handle.onConnectionRejected((r) => setRejection(r));
      onReady(handle);
    })();

    return () => {
      alive = false;
      unsubChange?.();
      unsubSel?.();
      unsubRej?.();
      handleRef.current?.destroy();
      handleRef.current = null;
    };
    // Intentionally mount-once: Rete owns the DOM container and we
    // re-init only on unmount/remount, not on prop changes. The
    // handler functions are captured by closure and read the latest
    // refs at fire time.
  }, []);

  // Auto-dismiss rejection toasts after a short interval so the
  // canvas doesn't accumulate stale errors. User can also click X.
  useEffect(() => {
    if (!rejection) return;
    const t = setTimeout(() => setRejection(null), 6500);
    return () => clearTimeout(t);
  }, [rejection]);

  useImperativeHandle(
    ref,
    () => ({
      refresh: () => {
        // Fire the change handler synthetically so the code preview
        // recomputes after we mutate via imperative API.
        onChange();
      },
      flashSave: () => {
        // Trigger the .save-flash CSS animation by toggling the class.
        // Animation is 700ms; the timeout clears state after that.
        setSaveFlash(true);
        window.setTimeout(() => setSaveFlash(false), 800);
      },
    }),
    [onChange],
  );

  function onDragOver(e: DragEvent<HTMLDivElement>) {
    // Required to allow drop. Indicate that we'll accept the source.
    if (e.dataTransfer.types.includes(PALETTE_DRAG_MIME)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  }

  function onDragEnter(e: DragEvent<HTMLDivElement>) {
    if (!e.dataTransfer.types.includes(PALETTE_DRAG_MIME)) return;
    dragCounter.current += 1;
    if (dragCounter.current === 1) setDropActive(true);
  }

  function onDragLeave(e: DragEvent<HTMLDivElement>) {
    if (!e.dataTransfer.types.includes(PALETTE_DRAG_MIME)) return;
    dragCounter.current = Math.max(0, dragCounter.current - 1);
    if (dragCounter.current === 0) setDropActive(false);
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    dragCounter.current = 0;
    setDropActive(false);
    const componentId = e.dataTransfer.getData(PALETTE_DRAG_MIME);
    if (!componentId) return;
    e.preventDefault();
    const handle = handleRef.current;
    const container = containerRef.current;
    if (!handle || !container) return;
    const { x, y } = handle.screenToGraph(e.clientX, e.clientY, container);
    onDropComponent(componentId, x, y);
  }

  return (
    <div className="relative h-full w-full">
      <div
        ref={containerRef}
        onDragOver={onDragOver}
        onDragEnter={onDragEnter}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className={`canvas-grid h-full w-full ${dropActive ? 'drop-active' : ''} ${saveFlash ? 'save-flash' : ''}`}
      />
      {rejection && (
        <ConnectionRejectionToast rejection={rejection} onDismiss={() => setRejection(null)} />
      )}
    </div>
  );
});

// In-place connection-rejection toast. Surfaces the same validation
// error language the panel uses (per ADR-0034), at the moment of the
// rejected drag, so the user learns what's wrong in context rather
// than having to consult a side panel.
function ConnectionRejectionToast({
  rejection,
  onDismiss,
}: {
  rejection: ConnectionRejection;
  onDismiss: () => void;
}) {
  // Position bottom-center over the canvas — out of the way of nodes
  // but visible enough to read.
  return (
    <div
      role="alert"
      className="pointer-events-none absolute bottom-6 left-1/2 z-10 -translate-x-1/2"
    >
      <div className="glass border-accent-warm/40 pointer-events-auto flex max-w-xl items-start gap-2 rounded-lg border px-3 py-2 shadow-lg">
        <WarningCircle size={16} weight="duotone" className="text-accent-warm mt-0.5 shrink-0" />
        <div className="text-text min-w-0 flex-1 text-[11px]">
          <div className="font-medium">Connection rejected</div>
          <div className="text-dim mt-0.5 leading-snug">{rejection.summary}</div>
          {rejection.errors.length > 1 && (
            <div className="text-dim/70 mt-1 text-[10px]">
              +{rejection.errors.length - 1} other issue
              {rejection.errors.length - 1 === 1 ? '' : 's'}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="text-dim hover:bg-panel-2 hover:text-text shrink-0 rounded p-1 transition"
        >
          <X size={11} weight="bold" />
        </button>
      </div>
    </div>
  );
}
