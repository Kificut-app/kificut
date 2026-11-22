import Ajv from 'ajv'
import { describe, expect, it } from 'vitest'
import { AI_TOOLS } from './ai-tools'
import { TOOL_NAMES } from '../renderer/src/ai/tools'

describe('AI tool definitions', () => {
  it('have unique, snake_case names', () => {
    const names = AI_TOOLS.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
    for (const name of names) expect(name).toMatch(/^[a-z][a-z_]*[a-z]$/)
  })

  it('match the tools Kificut implements', () => {
    expect([...TOOL_NAMES].sort()).toEqual(AI_TOOLS.map((t) => t.name).sort())
  })

  it('have valid input schemas whose required fields exist', () => {
    const ajv = new Ajv({ strict: true, allowUnionTypes: true })
    for (const tool of AI_TOOLS) {
      expect(() => ajv.compile(tool.inputSchema), tool.name).not.toThrow()
      for (const key of tool.inputSchema.required ?? []) {
        expect(tool.inputSchema.properties, `${tool.name}.${key}`).toHaveProperty(key)
      }
      expect(tool.description.length, tool.name).toBeGreaterThan(30)
    }
  })

  it('mark only read tools as read only', () => {
    const readOnly = AI_TOOLS.filter((t) => t.annotations.readOnlyHint).map((t) => t.name)
    expect(readOnly.sort()).toEqual(
      [
        'analyze_media',
        'find_shots',
        'get_export_status',
        'get_project',
        'inspect_media',
        'list_ai_models',
        'list_generations',
        'list_media_files',
        'list_voices',
        'transcribe_media',
        'view_frame'
      ].sort()
    )
  })
})
