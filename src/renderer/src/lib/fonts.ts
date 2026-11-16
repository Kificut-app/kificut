import { useEffect, useState } from 'react'

const FALLBACK = [
  'Inter',
  'Arial',
  'Helvetica',
  'Helvetica Neue',
  'Segoe UI',
  'Roboto',
  'Verdana',
  'Tahoma',
  'Trebuchet MS',
  'Georgia',
  'Times New Roman',
  'Palatino',
  'Garamond',
  'Courier New',
  'Impact',
  'Futura',
  'Avenir',
  'system-ui',
  'serif',
  'sans-serif',
  'monospace'
]

interface LocalFont {
  family: string
}

let loading: Promise<string[]> | null = null

async function loadFonts(): Promise<string[]> {
  const query = (window as unknown as { queryLocalFonts?: () => Promise<LocalFont[]> }).queryLocalFonts
  if (!query) return FALLBACK
  try {
    const fonts = await query()
    const families = [...new Set(fonts.map((f) => f.family))].sort((a, b) => a.localeCompare(b))
    if (families.length === 0) return FALLBACK
    return ['Inter', ...families.filter((f) => f !== 'Inter')]
  } catch {
    return FALLBACK
  }
}

/** Installed font families, falling back to a list of common ones when the system will not say. */
export function useFonts(): string[] {
  const [fonts, setFonts] = useState<string[]>(FALLBACK)
  useEffect(() => {
    loading ??= loadFonts()
    let alive = true
    void loading.then((list) => alive && setFonts(list))
    return () => {
      alive = false
    }
  }, [])
  return fonts
}
