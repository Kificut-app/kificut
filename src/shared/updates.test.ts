import { describe, expect, it } from 'vitest'
import { isNewerVersion, pickMacInstaller, type ReleaseAsset } from './updates'

describe('isNewerVersion', () => {
  it('compares each part as a number', () => {
    expect(isNewerVersion('0.10.0', '0.9.9')).toBe(true)
    expect(isNewerVersion('1.0.0', '0.99.0')).toBe(true)
    expect(isNewerVersion('0.2.1', '0.2.0')).toBe(true)
    expect(isNewerVersion('v0.3.0', '0.2.9')).toBe(true)
  })

  it('is false for the same or an older version', () => {
    expect(isNewerVersion('0.2.0', '0.2.0')).toBe(false)
    expect(isNewerVersion('0.1.9', '0.2.0')).toBe(false)
    expect(isNewerVersion('0.2', '0.2.0')).toBe(false)
  })
})

describe('pickMacInstaller', () => {
  const digest = `sha256:${'ab'.repeat(32)}`
  const assets: ReleaseAsset[] = [
    { name: 'Kificut-0.3.0-win-x64.exe', browser_download_url: 'https://x/win', size: 1, digest },
    { name: 'Kificut-0.3.0-mac-arm64.dmg', browser_download_url: 'https://x/arm', size: 2, digest },
    { name: 'Kificut-0.3.0-mac-x64.dmg', browser_download_url: 'https://x/intel', size: 3, digest: null },
    { name: 'Kificut-0.3.0-mac-arm64.zip', browser_download_url: 'https://x/zip', size: 4, digest }
  ]

  it('picks the disk image for this Mac and its checksum', () => {
    expect(pickMacInstaller(assets, '0.3.0', 'arm64')).toEqual({ asset: assets[1], sha256: 'ab'.repeat(32) })
  })

  it('refuses an installer without a published checksum', () => {
    expect(pickMacInstaller(assets, '0.3.0', 'x64')).toBeNull()
  })

  it('returns null when the release has no installer for this version', () => {
    expect(pickMacInstaller(assets, '0.4.0', 'arm64')).toBeNull()
  })
})
