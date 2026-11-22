import { describe, expect, it } from 'vitest'
import { setMatMulAccuracy } from './onnx-patch'

/* A tiny protobuf writer and reader, enough to build and inspect ONNX graphs by hand. */

type Value = number | string | Uint8Array | Message
interface Message {
  fields: Array<[number, Value]>
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

function encode(message: Message): Uint8Array {
  const out: number[] = []
  for (const [number, value] of message.fields) {
    if (typeof value === 'number') {
      out.push(...varint(number * 8), ...varint(value))
    } else {
      const payload =
        typeof value === 'string'
          ? new TextEncoder().encode(value)
          : value instanceof Uint8Array
            ? value
            : encode(value)
      out.push(...varint(number * 8 + 2), ...varint(payload.length), ...payload)
    }
  }
  return Uint8Array.from(out)
}

interface Decoded {
  number: number
  wire: number
  int?: number
  bytes?: Uint8Array
}

function decode(bytes: Uint8Array): Decoded[] {
  const out: Decoded[] = []
  let at = 0
  const read = () => {
    let value = 0
    let scale = 1
    let byte: number
    do {
      byte = bytes[at++]
      value += (byte & 0x7f) * scale
      scale *= 128
    } while (byte & 0x80)
    return value
  }
  while (at < bytes.length) {
    const tag = read()
    const number = Math.floor(tag / 8)
    const wire = tag % 8
    if (wire === 0) out.push({ number, wire, int: read() })
    else if (wire === 2) {
      const length = read()
      out.push({ number, wire, bytes: bytes.subarray(at, at + length) })
      at += length
    } else throw new Error(`wire ${wire}`)
  }
  return out
}

const str = (b?: Uint8Array) => new TextDecoder().decode(b)

const attrInt = (name: string, value: number): Message => ({
  fields: [
    [1, name],
    [3, value],
    [20, 2]
  ]
})

const node = (opType: string, domain: string, attributes: Message[], name = opType): Message => ({
  fields: [
    [1, 'input'],
    [2, 'output'],
    [3, name],
    [4, opType],
    ...attributes.map((a) => [5, a] as [number, Value]),
    ...(domain ? [[7, domain] as [number, Value]] : [])
  ]
})

const matmul = (attributes: Message[], name: string) => node('MatMulNBits', 'com.microsoft', attributes, name)

/** Attributes of every node in a graph, by node name: name -> [attribute name, int value][] */
function attributesByNode(graph: Uint8Array): Map<string, Array<[string, number | undefined]>> {
  const result = new Map<string, Array<[string, number | undefined]>>()
  for (const field of decode(graph)) {
    if (field.number !== 1) continue
    const parts = decode(field.bytes!)
    const name = str(parts.find((p) => p.number === 3)?.bytes)
    const attrs = parts
      .filter((p) => p.number === 5)
      .map((p) => {
        const inner = decode(p.bytes!)
        return [str(inner.find((i) => i.number === 1)?.bytes), inner.find((i) => i.number === 3)?.int] as [
          string,
          number | undefined
        ]
      })
    result.set(name, attrs)
  }
  return result
}

const graphOf = (model: Uint8Array) => decode(model).find((f) => f.number === 7)!.bytes!

function buildModel(): Uint8Array {
  const thenBranch: Message = {
    fields: [
      [1, matmul([attrInt('K', 64)], 'inner')],
      [2, 'then']
    ]
  }
  const graph: Message = {
    fields: [
      [1, matmul([attrInt('K', 1024), attrInt('N', 1024), attrInt('bits', 4)], 'missing')],
      [1, matmul([attrInt('accuracy_level', 0), attrInt('block_size', 32)], 'zero')],
      [1, node('MatMulNBits', 'other.domain', [attrInt('K', 8)], 'foreign')],
      [1, node('Add', '', [], 'add')],
      [
        1,
        node(
          'If',
          '',
          [
            {
              fields: [
                [1, 'then_branch'],
                [6, thenBranch],
                [20, 5]
              ]
            }
          ],
          'branch'
        )
      ],
      [2, 'main'],
      [5, Uint8Array.from([1, 2, 3, 4, 5])]
    ]
  }
  return encode({
    fields: [
      [1, 8],
      [2, 'exporter'],
      [7, graph],
      [8, { fields: [[2, 17]] }],
      [14, { fields: [[1, 'key']] }]
    ]
  })
}

describe('setMatMulAccuracy', () => {
  it('sets accuracy_level 4 on every MatMulNBits node, replacing an existing value', () => {
    const { bytes, nodes } = setMatMulAccuracy(buildModel())
    expect(nodes).toBe(3)
    const byNode = attributesByNode(graphOf(bytes))
    expect(byNode.get('missing')).toEqual([
      ['K', 1024],
      ['N', 1024],
      ['bits', 4],
      ['accuracy_level', 4]
    ])
    expect(byNode.get('zero')).toEqual([
      ['block_size', 32],
      ['accuracy_level', 4]
    ])
  })

  it('leaves other nodes and ops from other domains alone', () => {
    const before = attributesByNode(graphOf(buildModel()))
    const after = attributesByNode(graphOf(setMatMulAccuracy(buildModel()).bytes))
    expect(after.get('foreign')).toEqual(before.get('foreign'))
    expect(after.get('add')).toEqual([])
  })

  it('patches graphs nested in attributes', () => {
    const graph = graphOf(setMatMulAccuracy(buildModel()).bytes)
    const ifNode = decode(graph)
      .filter((f) => f.number === 1)
      .map((f) => decode(f.bytes!))
      .find((parts) => str(parts.find((p) => p.number === 3)?.bytes) === 'branch')!
    const attribute = decode(ifNode.find((p) => p.number === 5)!.bytes!)
    const body = attribute.find((p) => p.number === 6)!.bytes!
    expect(attributesByNode(body).get('inner')).toEqual([
      ['K', 64],
      ['accuracy_level', 4]
    ])
  })

  it('copies every field outside the nodes byte for byte', () => {
    const original = decode(buildModel())
    const patched = decode(setMatMulAccuracy(buildModel()).bytes)
    expect(patched.map((f) => f.number)).toEqual(original.map((f) => f.number))
    for (const [i, field] of original.entries()) {
      if (field.number !== 7) expect(patched[i]).toEqual(field)
    }
    const graphFields = (m: Decoded[]) =>
      decode(m.find((f) => f.number === 7)!.bytes!).filter((f) => f.number !== 1)
    expect(graphFields(patched)).toEqual(graphFields(original))
  })

  it('gives the same bytes when run twice, and returns models without the op unchanged', () => {
    const once = setMatMulAccuracy(buildModel()).bytes
    expect(Array.from(setMatMulAccuracy(once).bytes)).toEqual(Array.from(once))

    const plain = encode({ fields: [[7, { fields: [[1, node('Add', '', [], 'add')]] }]] })
    const result = setMatMulAccuracy(plain)
    expect(result.nodes).toBe(0)
    expect(Array.from(result.bytes)).toEqual(Array.from(plain))
  })

  it('rejects a file that is cut short', () => {
    const bytes = buildModel()
    expect(() => setMatMulAccuracy(bytes.subarray(0, bytes.length - 3))).toThrow(/cut short/)
  })
})
