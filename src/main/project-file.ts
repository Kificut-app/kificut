import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import type { MediaItem, ProjectFile } from '@shared/types'

function isProjectFile(data: unknown): data is ProjectFile {
  const file = data as ProjectFile
  return !!file && file.app === 'kificut' && !!file.project && Array.isArray(file.project.media)
}

/** Stores each media path relative to the project file as well, so moved projects can be repaired. */
export function prepareForSave(data: unknown, target: string): unknown {
  if (!isProjectFile(data)) return data
  const base = dirname(target)
  const media = data.project.media.map((item: MediaItem) => {
    const rel = relative(base, item.path)
    return { ...item, relativePath: isAbsolute(rel) ? undefined : rel.split('\\').join('/') }
  })
  return { ...data, project: { ...data.project, media } }
}

/** Reads a project and points missing media at the copy next to the project, when there is one. */
export async function readProject(path: string): Promise<unknown> {
  const data: unknown = JSON.parse(await readFile(path, 'utf8'))
  if (!isProjectFile(data)) throw new Error('This is not a Kificut project file.')
  const base = dirname(path)
  for (const item of data.project.media) {
    if (existsSync(item.path) || !item.relativePath) continue
    const candidate = resolve(base, item.relativePath)
    if (existsSync(candidate)) item.path = candidate
  }
  return data
}
