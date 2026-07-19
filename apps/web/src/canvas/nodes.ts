// Rete.js v2 node + socket subclasses that carry tensor signatures.
//
// Each port (input or output) has its own socket instance whose `name`
// encodes the source component's port id. Connection-type validation
// uses the carried tensor signature to call `isCompatible` from
// @epagoge/components and reject mismatches before they enter the
// editor state.

import { ClassicPreset } from 'rete';
import type {
  ComponentSpec,
  PropertyValue,
  ResolvedProperties,
  TensorSignature,
} from '@epagoge/components';

/**
 * Socket variant that carries the tensor signature for its port. The
 * canvas inspector + connection-type validation both read it.
 */
export class TensorSocket extends ClassicPreset.Socket {
  constructor(
    name: string,
    public signature: TensorSignature,
  ) {
    super(name);
  }
}

/**
 * One node instance on the canvas. Wraps a ComponentSpec from the
 * registry plus the resolved properties the user has set on this
 * instance. The node id is canvas-assigned and stable across saves.
 */
export class ArchitectureNode extends ClassicPreset.Node<
  Record<string, TensorSocket>,
  Record<string, TensorSocket>,
  Record<string, never>
> {
  readonly componentId: string;

  constructor(
    public spec: ComponentSpec,
    public properties: ResolvedProperties,
  ) {
    super(spec.name);
    this.componentId = spec.id;

    // Resolve port signatures against the current property values and
    // attach typed sockets. Re-resolution on property changes happens
    // by updating `this.properties` then calling `rebuildSockets()`.
    for (const port of spec.inputs) {
      const sig = port.signature(properties);
      this.addInput(port.id, new ClassicPreset.Input(new TensorSocket(port.id, sig), port.label));
    }
    for (const port of spec.outputs) {
      const sig = port.signature(properties);
      this.addOutput(port.id, new ClassicPreset.Output(new TensorSocket(port.id, sig), port.label));
    }
  }

  /**
   * Re-resolve all port signatures against the current `properties`
   * value. Called after a property edit so downstream connection
   * validation reflects the new shape.
   */
  rebuildSockets(): void {
    for (const port of this.spec.inputs) {
      const input = this.inputs[port.id];
      if (input) {
        input.socket = new TensorSocket(port.id, port.signature(this.properties));
      }
    }
    for (const port of this.spec.outputs) {
      const output = this.outputs[port.id];
      if (output) {
        output.socket = new TensorSocket(port.id, port.signature(this.properties));
      }
    }
  }

  setProperty(id: string, value: PropertyValue): void {
    this.properties = { ...this.properties, [id]: value };
    this.rebuildSockets();
  }
}

/**
 * Connection type used by the Rete scheme. We parameterize against the
 * base ClassicPreset.Node so the React + connection presets — which
 * are typed against the loose ClassicScheme — slot in without variance
 * fights. Anywhere code needs the ArchitectureNode-specific fields it
 * casts explicitly (via `editor.getNode(id) as ArchitectureNode`).
 */
export type Connection = ClassicPreset.Connection<ClassicPreset.Node, ClassicPreset.Node>;

export type SchemeNode = ArchitectureNode;
export type SchemeConn = Connection;
