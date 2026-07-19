// Code preview — Phase 0 sub-phase E, tranche E8.
//
// Per ADR-0035: the generated PyTorch is a SECOND VIEW of the same
// architecture the canvas shows. The two surfaces should feel
// continuous — change a node, see the code update; click a node,
// see its lines highlighted; click a line, see its node selected.
//
// Bidirectional navigation is load-bearing for the "one tool" feel:
// without it the code is a separate document; with it the code is
// a navigable view of the canvas.

import { useEffect, useMemo, useRef } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import { generatePytorchWithSourceMap, type GraphSpec } from '@epagoge/codegen';
import type { ComponentRegistry } from '@epagoge/components';

// Monaco types are loaded by the editor itself; we use unknown for the
// editor instance to avoid pulling in monaco-editor's massive types.
type MonacoEditor = Parameters<OnMount>[0];
type MonacoModule = Parameters<OnMount>[1];

interface Props {
  graph: GraphSpec | null;
  registry: ComponentRegistry;
  /** Node ids to highlight in the code (canvas → code direction). */
  highlightedNodeIds?: readonly string[];
  /** Called when the user clicks a code line whose source node is
   *  known (code → canvas direction). */
  onLineClicked?: (nodeId: string) => void;
}

export function CodePreview({ graph, registry, highlightedNodeIds, onLineClicked }: Props) {
  const editorRef = useRef<MonacoEditor | null>(null);
  const monacoRef = useRef<MonacoModule | null>(null);
  const decorationsRef = useRef<string[]>([]);
  // Cache of last-applied lineToNodeId so click handler can resolve
  // without re-running codegen.
  const lineMapRef = useRef<ReadonlyMap<number, string>>(new Map());

  const { code, nodeRanges, lineToNodeId, error } = useMemo(() => {
    if (!graph || graph.nodes.length === 0) {
      return {
        code: '# Drop components onto the canvas to generate PyTorch.\n',
        nodeRanges: new Map(),
        lineToNodeId: new Map(),
        error: null,
      };
    }
    try {
      const result = generatePytorchWithSourceMap(graph, registry);
      return {
        code: result.code,
        nodeRanges: result.nodeRanges,
        lineToNodeId: result.lineToNodeId,
        error: null,
      };
    } catch (err) {
      return {
        code: '',
        nodeRanges: new Map(),
        lineToNodeId: new Map(),
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }, [graph, registry]);

  // Keep the click-handler's view of the line map fresh without
  // re-binding the Monaco listener each render.
  useEffect(() => {
    lineMapRef.current = lineToNodeId;
  }, [lineToNodeId]);

  // Apply highlight decorations when the selection changes. Monaco
  // uses delta-decoration ids to manage line decorations across
  // re-renders without flicker.
  useEffect(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco) return;
    const decorations: {
      range: InstanceType<MonacoModule['Range']>;
      options: { isWholeLine: boolean; className: string; linesDecorationsClassName?: string };
    }[] = [];
    for (const nodeId of highlightedNodeIds ?? []) {
      const ranges = nodeRanges.get(nodeId);
      if (!ranges) continue;
      for (const [start, end] of [...ranges.initRanges, ...ranges.forwardRanges]) {
        decorations.push({
          range: new monaco.Range(start, 1, end, 1),
          options: {
            isWholeLine: true,
            className: 'epg-line-highlighted',
            linesDecorationsClassName: 'epg-line-gutter-highlighted',
          },
        });
      }
    }
    decorationsRef.current = editor.deltaDecorations(decorationsRef.current, decorations);
  }, [highlightedNodeIds, nodeRanges]);

  const onMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;

    // Click handler — route code-line clicks back to the canvas.
    editor.onMouseDown((e) => {
      const line = e.target.position?.lineNumber;
      if (!line) return;
      const nodeId = lineMapRef.current.get(line);
      if (nodeId && onLineClicked) onLineClicked(nodeId);
    });
  };

  return (
    <div className="flex h-full flex-col">
      <style>{`
        .epg-line-highlighted {
          background: rgba(16, 185, 129, 0.08);
        }
        .epg-line-gutter-highlighted {
          background: rgb(16, 185, 129);
          width: 3px !important;
          margin-left: 0;
        }
      `}</style>
      <div className="flex items-center justify-between border-b border-neutral-800 px-3 py-2">
        <div className="text-xs uppercase tracking-wide text-neutral-500">PyTorch</div>
        <div className="flex items-center gap-2">
          {(highlightedNodeIds?.length ?? 0) > 0 && (
            <span className="rounded bg-emerald-900/40 px-2 py-0.5 text-[10px] text-emerald-200">
              {highlightedNodeIds!.length === 1
                ? '1 node highlighted'
                : `${highlightedNodeIds!.length} nodes highlighted`}
            </span>
          )}
          {error && (
            <span className="rounded bg-amber-900/40 px-2 py-0.5 text-[10px] text-amber-200">
              {error}
            </span>
          )}
        </div>
      </div>
      <div className="flex-1 overflow-hidden">
        {error ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-xs text-neutral-500">
            <div className="text-amber-400">graph has errors</div>
            <div className="text-neutral-600">{error}</div>
          </div>
        ) : (
          <Editor
            height="100%"
            language="python"
            value={code}
            theme="vs-dark"
            onMount={onMount}
            options={{
              readOnly: true,
              minimap: { enabled: false },
              fontSize: 12,
              scrollBeyondLastLine: false,
              renderWhitespace: 'selection',
              lineNumbers: 'on',
              wordWrap: 'on',
              // Preserve scroll position across value updates so the
              // user doesn't lose their place when the canvas changes.
              // Monaco does this naturally for controlled-value mode
              // as long as we don't dispose/recreate the model.
            }}
          />
        )}
      </div>
    </div>
  );
}
