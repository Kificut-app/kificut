import { describe, expect, it } from 'vitest'
import { desktopEntry, MIME_PACKAGE } from './linux-desktop'

const lines = (entry: string) =>
  Object.fromEntries(
    entry
      .trim()
      .split('\n')
      .slice(1)
      .map((l) => l.split(/=(.*)/s).slice(0, 2))
  )

describe('desktopEntry', () => {
  it('points at the AppImage, matches the window and claims the project file type', () => {
    const entry = desktopEntry('/home/sam/Apps/Kificut-0.3.0-linux-x86_64.AppImage', '0.3.0')
    expect(entry.startsWith('[Desktop Entry]\n')).toBe(true)
    const keys = lines(entry)
    expect(keys.Exec).toBe('"/home/sam/Apps/Kificut-0.3.0-linux-x86_64.AppImage" %U')
    expect(keys.TryExec).toBe('/home/sam/Apps/Kificut-0.3.0-linux-x86_64.AppImage')
    expect(keys.Icon).toBe('kificut')
    // Must match desktopName in package.json, which is the app ID on Wayland and for the portals.
    expect(keys.StartupWMClass).toBe('kificut')
    expect(keys.MimeType).toBe('application/x-kificut-project;')
    expect(keys['X-AppImage-Version']).toBe('0.3.0')
    expect(keys['X-Kificut-Managed']).toBe('true')
  })

  it('quotes and escapes awkward paths as the Desktop Entry specification asks', () => {
    const keys = lines(desktopEntry('/home/sam/My "Apps"/$HOME/50%/back\\slash.AppImage', '1.0.0'))
    // Inside quotes: \" \$ \\ ; then every backslash doubles for the string value; % becomes %%.
    expect(keys.Exec).toBe('"/home/sam/My \\\\"Apps\\\\"/\\\\$HOME/50%%/back\\\\\\\\slash.AppImage" %U')
    expect(keys.TryExec).toBe('/home/sam/My "Apps"/$HOME/50%/back\\\\slash.AppImage')
  })

  it('keeps spaces inside the quotes', () => {
    expect(lines(desktopEntry('/media/USB stick/Kificut.AppImage', '1.0.0')).Exec).toBe(
      '"/media/USB stick/Kificut.AppImage" %U'
    )
  })
})

describe('MIME_PACKAGE', () => {
  it('maps .kificut files to the project type', () => {
    expect(MIME_PACKAGE).toContain('<mime-type type="application/x-kificut-project">')
    expect(MIME_PACKAGE).toContain('<glob pattern="*.kificut"/>')
  })
})
