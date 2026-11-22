import { readFile, rename, writeFile } from 'node:fs/promises'

/*
 * Switches the 4 bit matrix multiplications in an ONNX graph to ONNX Runtime's fast CPU path.
 *
 * MatMulNBits nodes take an `accuracy_level` attribute. At 4, ONNX Runtime turns the activations
 * into 8 bit integers and multiplies with integer dot products; at 0, the default when the
 * attribute is missing, it unpacks the weights to 32 bit floats for every multiplication.
 * Chatterbox Turbo's export leaves the attribute out, which makes its language model about a
 * quarter slower on a CPU with no audible difference. Only the small graph file changes; the
 * weights in the .onnx_data file stay as published.
 *
 * The graph file is a protobuf ModelProto. This walks just enough of it (model, graph, node,
 * attribute, and graphs nested in attributes) and copies every other byte unchanged.
 */

const WIRE_VARINT = 0
const WIRE_FIXED64 = 1
const WIRE_LENGTH = 2
const WIRE_FIXED32 = 5

const MODEL_GRAPH = 7
const GRAPH_NODE = 1
const NODE_OP_TYPE = 4
const NODE_ATTRIBUTE = 5
const NODE_DOMAIN = 7
const ATTRIBUTE_NAME = 1
const ATTRIBUTE_INT = 3
const ATTRIBUTE_GRAPH = 6
const ATTRIBUTE_GRAPHS = 11
const ATTRIBUTE_TYPE = 20
const ATTRIBUTE_TYPE_INT = 2

const ACCURACY = 'accuracy_level'

interface Field {
  number: number
  wire: number
  /** Where the tag starts. */
  start: number
  /** Where the value starts (after the length, for length delimited fields). */
  value: number
  end: number
}

function readVarint(bytes: Uint8Array, at: number): { value: number; next: number } {
  let value = 0
  let scale = 1
  let byte: number
  do {
    if (at >= bytes.length) throw new Error('The ONNX file is cut short.')
    byte = bytes[at++]
    // Only tags and lengths are used, which fit in a double; longer integers are copied as bytes.
    value += (byte & 0x7f) * scale
    scale *= 128
  } while (byte & 0x80)
  return { value, next: at }
}

function* fields(bytes: Uint8Array, start: number, end: number): Generator<Field> {
  let at = start
  while (at < end) {
    const tag = readVarint(bytes, at)
    const number = Math.floor(tag.value / 8)
    const wire = tag.value % 8
    let value = tag.next
    let fieldEnd: number
    if (wire === WIRE_VARINT) fieldEnd = readVarint(bytes, value).next
    else if (wire === WIRE_FIXED64) fieldEnd = value + 8
    else if (wire === WIRE_FIXED32) fieldEnd = value + 4
    else if (wire === WIRE_LENGTH) {
      const length = readVarint(bytes, value)
      value = length.next
      fieldEnd = length.next + length.value
    } else throw new Error(`The ONNX file uses protobuf wire type ${wire}, which is not supported.`)
    if (fieldEnd > end) throw new Error('The ONNX file is cut short.')
    yield { number, wire, start: at, value, end: fieldEnd }
    at = fieldEnd
  }
}

function varint(value: number): number[] {
  const out: number[] = []
  while (value > 0x7f) {
    out.push((value % 128) | 0x80)
    value = Math.floor(value / 128)
  }
  out.push(value)
  return out
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

function lengthField(number: number, payload: Uint8Array): Uint8Array {
  return concat([Uint8Array.from([...varint(number * 8 + WIRE_LENGTH), ...varint(payload.length)]), payload])
}

function varintField(number: number, value: number): Uint8Array {
  return Uint8Array.from([...varint(number * 8 + WIRE_VARINT), ...varint(value)])
}

const text = new TextDecoder()

function stringAt(bytes: Uint8Array, field: Field): string {
  return text.decode(bytes.subarray(field.value, field.end))
}

interface Rewrite {
  bytes: Uint8Array
  nodes: number
}

/** Rewrites the length delimited children `wanted` with `rewrite`; copies everything else. */
function rewriteChildren(
  bytes: Uint8Array,
  start: number,
  end: number,
  wanted: (field: Field) => boolean,
  rewrite: (field: Field) => Rewrite
): Rewrite {
  const parts: Uint8Array[] = []
  let nodes = 0
  for (const field of fields(bytes, start, end)) {
    if (field.wire === WIRE_LENGTH && wanted(field)) {
      const child = rewrite(field)
      if (child.nodes > 0) {
        parts.push(lengthField(field.number, child.bytes))
        nodes += child.nodes
        continue
      }
    }
    parts.push(bytes.subarray(field.start, field.end))
  }
  return { bytes: nodes > 0 ? concat(parts) : bytes.subarray(start, end), nodes }
}

function patchGraph(bytes: Uint8Array, start: number, end: number, level: number): Rewrite {
  return rewriteChildren(
    bytes,
    start,
    end,
    (f) => f.number === GRAPH_NODE,
    (f) => patchNode(bytes, f.value, f.end, level)
  )
}

function attributeName(bytes: Uint8Array, field: Field): string | null {
  for (const inner of fields(bytes, field.value, field.end)) {
    if (inner.number === ATTRIBUTE_NAME && inner.wire === WIRE_LENGTH) return stringAt(bytes, inner)
  }
  return null
}

function patchNode(bytes: Uint8Array, start: number, end: number, level: number): Rewrite {
  const list = [...fields(bytes, start, end)]
  const opType = list.find((f) => f.number === NODE_OP_TYPE && f.wire === WIRE_LENGTH)
  const domain = list.find((f) => f.number === NODE_DOMAIN && f.wire === WIRE_LENGTH)
  const isMatMulNBits =
    opType &&
    stringAt(bytes, opType) === 'MatMulNBits' &&
    domain &&
    stringAt(bytes, domain) === 'com.microsoft'

  if (isMatMulNBits) {
    const kept = list.filter(
      (f) => !(f.number === NODE_ATTRIBUTE && f.wire === WIRE_LENGTH && attributeName(bytes, f) === ACCURACY)
    )
    const attribute = concat([
      lengthField(ATTRIBUTE_NAME, new TextEncoder().encode(ACCURACY)),
      varintField(ATTRIBUTE_INT, level),
      varintField(ATTRIBUTE_TYPE, ATTRIBUTE_TYPE_INT)
    ])
    return {
      bytes: concat([
        ...kept.map((f) => bytes.subarray(f.start, f.end)),
        lengthField(NODE_ATTRIBUTE, attribute)
      ]),
      nodes: 1
    }
  }

  // Control flow nodes (If, Loop, Scan) carry their bodies as graphs inside attributes.
  return rewriteChildren(
    bytes,
    start,
    end,
    (f) => f.number === NODE_ATTRIBUTE,
    (f) =>
      rewriteChildren(
        bytes,
        f.value,
        f.end,
        (inner) => inner.number === ATTRIBUTE_GRAPH || inner.number === ATTRIBUTE_GRAPHS,
        (inner) => patchGraph(bytes, inner.value, inner.end, level)
      )
  )
}

/**
 * Sets `accuracy_level` on every MatMulNBits node in an ONNX ModelProto. Returns the new bytes
 * and how many nodes were set; running it again gives the same bytes.
 */
export function setMatMulAccuracy(model: Uint8Array, level = 4): Rewrite {
  return rewriteChildren(
    model,
    0,
    model.length,
    (f) => f.number === MODEL_GRAPH,
    (f) => patchGraph(model, f.value, f.end, level)
  )
}

/** Patches a graph file in place (through a temporary file). Returns the number of nodes set. */
export async function useFastMatMuls(path: string): Promise<number> {
  const result = setMatMulAccuracy(new Uint8Array(await readFile(path)))
  if (result.nodes > 0) {
    await writeFile(`${path}.part`, result.bytes)
    await rename(`${path}.part`, path)
  }
  return result.nodes
}
