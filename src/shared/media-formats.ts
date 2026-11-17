/** File extensions Kificut offers to import. */
export const VIDEO_EXTENSIONS = [
  'mp4',
  'mov',
  'm4v',
  'mkv',
  'webm',
  'avi',
  'mts',
  'm2ts',
  'mxf',
  'wmv',
  'flv',
  'mpg',
  'mpeg',
  'ts',
  '3gp'
]
export const AUDIO_EXTENSIONS = ['mp3', 'wav', 'aac', 'm4a', 'flac', 'ogg', 'opus', 'aif', 'aiff', 'wma']
export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'tif', 'tiff']
export const MEDIA_EXTENSIONS = [...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS, ...IMAGE_EXTENSIONS]

export function isMediaFile(name: string): boolean {
  const dot = name.lastIndexOf('.')
  return dot > 0 && MEDIA_EXTENSIONS.includes(name.slice(dot + 1).toLowerCase())
}
