import { useEffect, useState, type ReactNode } from 'react'
import { RECORDING_SHORTCUTS, shortcutLabel } from '@shared/recording'
import { CircleAlert, CircleCheck, ExternalLink } from 'lucide-react'
import type { AppSettings, ToolInfo } from '@shared/types'
import { setDialog, useEditor } from '../../store/editor'
import { toast, useUi } from '../../store/ui'
import { checkForUpdates, installUpdate, useUpdates } from '../../store/updates'
import type { ClaudeCodeResult } from '@shared/ipc'
import { altKey, deleteKey, isMac, modKey, shiftKey } from '../../lib/platform'
import { Button, Kbd, Select, Switch } from '../ui/controls'
import { Modal } from '../ui/overlays'
import { LogoMark } from '../Logo'

const REPO = 'https://github.com/Kificut-app/kificut'

function SettingRow({ label, detail, children }: { label: string; detail?: string; children: ReactNode }) {
  return (
    <div className="setting">
      <div className="setting__text">
        <span className="setting__label">{label}</span>
        {detail && <span className="setting__detail">{detail}</span>}
      </div>
      <div className="setting__control">{children}</div>
    </div>
  )
}

export function PreferencesDialog() {
  const settings = useEditor((s) => s.settings)
  const [tools, setTools] = useState<ToolInfo | null>(null)

  const refreshTools = () => void window.kificut.settings.tools().then(setTools)
  useEffect(refreshTools, [])

  const update = async (patch: Partial<AppSettings>) => {
    const next = await window.kificut.settings.set(patch)
    useEditor.setState({ settings: next })
    if ('ffmpegPath' in patch || 'ffprobePath' in patch) refreshTools()
  }

  const browse = async (key: 'ffmpegPath' | 'ffprobePath') => {
    const path = await window.kificut.settings.pickBinary()
    if (path) await update({ [key]: path })
  }

  if (!settings) return null

  const installClaude = async () => {
    const result = await window.kificut.ai.installClaude()
    if (result.ok) {
      toast({
        kind: 'info',
        title: 'Opening Claude Desktop',
        message: 'Confirm the install there, then ask Claude to edit something in Kificut.'
      })
    } else {
      toast({
        kind: 'error',
        title: 'Could not open the connector',
        message: `${result.error ?? ''}\nClaude Desktop needs to be installed first.`.trim()
      })
    }
  }

  return (
    <Modal title="Settings" onClose={() => setDialog(null)} width={600}>
      <div className="settings">
        <h3 className="settings__heading">Editing</h3>
        <SettingRow label="Autosave" detail="Saves projects that already have a file on disk.">
          <Switch
            checked={settings.autosave}
            onChange={(autosave) => void update({ autosave })}
            label="Autosave"
          />
        </SettingRow>
        {settings.autosave && (
          <SettingRow label="Autosave interval">
            <Select
              value={settings.autosaveMinutes}
              options={[1, 2, 3, 5, 10].map((m) => ({ value: m, label: `Every ${m} min` }))}
              onChange={(autosaveMinutes) => void update({ autosaveMinutes })}
            />
          </SettingRow>
        )}
        <SettingRow label="Timeline thumbnails">
          <Switch
            checked={settings.showThumbnails}
            onChange={(showThumbnails) => void update({ showThumbnails })}
          />
        </SettingRow>
        <SettingRow label="Audio waveforms">
          <Switch
            checked={settings.showWaveforms}
            onChange={(showWaveforms) => void update({ showWaveforms })}
          />
        </SettingRow>

        <h3 className="settings__heading">Playback</h3>
        <SettingRow
          label="Preview files for large footage"
          detail="Creates lightweight copies for smoother playback. Exports always use the originals."
        >
          <Select
            value={settings.proxyAboveHeight}
            options={[
              { value: 0, label: 'Only when needed' },
              { value: 1080, label: 'Above 1080p' },
              { value: 720, label: 'Above 720p' }
            ]}
            onChange={(proxyAboveHeight) => void update({ proxyAboveHeight })}
          />
        </SettingRow>

        <h3 className="settings__heading">Claude</h3>
        <SettingRow
          label="Let Claude edit in Kificut"
          detail="Claude Desktop or Claude Code can import media, build the timeline and export. Every change can be undone."
        >
          <Switch
            checked={settings.connectorEnabled}
            onChange={(connectorEnabled) => void update({ connectorEnabled })}
            label="Let Claude edit in Kificut"
          />
        </SettingRow>
        <ClaudeConnector enabled={settings.connectorEnabled} onInstall={() => void installClaude()} />
        <ClaudeCodeConnector enabled={settings.connectorEnabled} />

        <h3 className="settings__heading">Updates</h3>
        <SettingRow
          label="Check for updates automatically"
          detail={
            window.kificut.platform === 'darwin'
              ? 'Downloads new versions in the background and opens the installer when you are ready.'
              : 'Downloads new versions in the background and installs them when you restart.'
          }
        >
          <Switch
            checked={settings.autoUpdate}
            onChange={(autoUpdate) => void update({ autoUpdate })}
            label="Check for updates automatically"
          />
        </SettingRow>
        <UpdatePanel />

        <h3 className="settings__heading">FFmpeg</h3>
        <p className="settings__note">
          Kificut ships with FFmpeg. You can point it at your own build, for example one with hardware
          encoders.
        </p>
        {(['ffmpegPath', 'ffprobePath'] as const).map((key) => {
          const info = key === 'ffmpegPath' ? tools?.ffmpeg : tools?.ffprobe
          const name = key === 'ffmpegPath' ? 'ffmpeg' : 'ffprobe'
          return (
            <div key={key} className="tool">
              <div className="tool__status">
                {info?.ok ? (
                  <CircleCheck size={15} className="is-success" />
                ) : (
                  <CircleAlert size={15} className="is-error" />
                )}
                <span className="tool__name">{name}</span>
                <span className="tool__version">
                  {info ? (info.ok ? (info.version ?? 'unknown version') : 'not found') : 'checking'}
                </span>
              </div>
              <div className="tool__path" title={info?.path}>
                {settings[key] ? settings[key] : 'Bundled'}
              </div>
              <div className="tool__actions">
                <Button size="sm" onClick={() => void browse(key)}>
                  Choose…
                </Button>
                {settings[key] && (
                  <Button size="sm" variant="ghost" onClick={() => void update({ [key]: '' })}>
                    Use Bundled
                  </Button>
                )}
              </div>
            </div>
          )
        })}
      </div>
      <div className="modal__actions">
        <Button variant="primary" onClick={() => setDialog(null)}>
          Done
        </Button>
      </div>
    </Modal>
  )
}

const SHORTCUTS: Array<{ group: string; items: Array<[string, string]> }> = [
  {
    group: 'Recording',
    items: [
      ['New recording', `${modKey}${shiftKey}R`],
      ['Pause / resume, anywhere while recording', shortcutLabel(RECORDING_SHORTCUTS.pause, isMac)],
      ['Stop and save, anywhere while recording', shortcutLabel(RECORDING_SHORTCUTS.stop, isMac)]
    ]
  },
  {
    group: 'Playback',
    items: [
      ['Play / pause', 'Space'],
      ['Play backward, pause, play forward', 'J  K  L'],
      ['Previous / next frame', '←  →'],
      ['Back / forward one second', `${shiftKey}←  ${shiftKey}→`],
      ['Previous / next edit', '↑  ↓'],
      ['Go to start / end', 'Home  End'],
      ['Set in / out point', 'I  O'],
      ['Clear in and out', `${altKey}X`]
    ]
  },
  {
    group: 'Editing',
    items: [
      ['Selection tool', 'V'],
      ['Razor tool', 'C'],
      ['Split at playhead', `S  or  ${modKey}K`],
      ['Delete', deleteKey],
      ['Ripple delete', `${shiftKey}${deleteKey}`],
      ['Duplicate', `${modKey}D`],
      ['Cut / copy / paste', `${modKey}X  ${modKey}C  ${modKey}V`],
      ['Nudge selection one frame', `${altKey}←  ${altKey}→`],
      ['Duplicate while dragging', `Hold ${isMac ? '⌥' : 'Alt'}`],
      ['Ignore snapping while dragging', `Hold ${isMac ? '⇧' : 'Shift'}`],
      ['Add marker', 'M'],
      ['Add text', 'T'],
      ['Select all', `${modKey}A`],
      ['Undo / redo', `${modKey}Z  ${isMac ? '⌘⇧Z' : 'Ctrl+Y'}`]
    ]
  },
  {
    group: 'Timeline',
    items: [
      ['Zoom in / out', '=  -'],
      ['Zoom to fit', `${shiftKey}Z`],
      ['Zoom at pointer', `${modKey}Scroll`],
      ['Toggle snapping', 'N']
    ]
  },
  {
    group: 'Project',
    items: [
      ['New project', `${modKey}N`],
      ['Open project', `${modKey}O`],
      ['Save / save as', `${modKey}S  ${modKey}${shiftKey}S`],
      ['Import media', `${modKey}I`],
      ['Export', `${modKey}E`]
    ]
  }
]

export function ShortcutsDialog() {
  return (
    <Modal title="Keyboard Shortcuts" onClose={() => setDialog(null)} width={680}>
      <div className="shortcuts">
        {SHORTCUTS.map((section) => (
          <div key={section.group} className="shortcuts__group">
            <h3>{section.group}</h3>
            <dl>
              {section.items.map(([label, keys]) => (
                <div key={label} className="shortcuts__row">
                  <dt>{label}</dt>
                  <dd>
                    {keys.split(/\s{2,}/).map((k) => (
                      <Kbd key={k}>{k}</Kbd>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
    </Modal>
  )
}

export function AboutDialog() {
  const versions = window.kificut.versions
  return (
    <Modal title="About" onClose={() => setDialog(null)} width={420}>
      <div className="about">
        <LogoMark size={56} />
        <h2>Kificut</h2>
        <p className="about__version">Version {versions.app || 'dev'}</p>
        <p>A free and open source video editor.</p>
        <p className="about__fine">
          Electron {versions.electron}, Chromium {versions.chrome}, Node {versions.node}
          <br />
          Kificut is released under the MIT license. Media processing uses FFmpeg, which is licensed
          separately under the LGPL/GPL.
        </p>
        <div className="about__links">
          <Button
            size="sm"
            variant="ghost"
            icon={<ExternalLink size={13} />}
            onClick={() => window.kificut.shell.openExternal(REPO)}
          >
            Source code
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon={<ExternalLink size={13} />}
            onClick={() => window.kificut.shell.openExternal(`${REPO}/issues`)}
          >
            Report an issue
          </Button>
        </div>
      </div>
    </Modal>
  )
}

function ClaudeConnector({ enabled, onInstall }: { enabled: boolean; onInstall: () => void }) {
  const status = useUi((s) => s.ai.status)
  const state = !enabled
    ? 'Off'
    : status?.connected
      ? `Connected to ${status.client ?? 'Claude'}`
      : 'Not connected yet'
  return (
    <div className="tool">
      <div className="tool__status">
        {enabled && status?.connected ? (
          <CircleCheck size={15} className="is-success" />
        ) : (
          <span className="tool__idle" />
        )}
        <span className="tool__name">Claude Desktop</span>
        <span className="tool__version">{state}</span>
      </div>
      <div className="tool__path">Claude sees the project details, file names and frames it asks for.</div>
      <div className="tool__actions">
        <Button size="sm" disabled={!enabled || status?.bundleAvailable === false} onClick={onInstall}>
          Install in Claude Desktop
        </Button>
      </div>
    </div>
  )
}

function ClaudeCodeConnector({ enabled }: { enabled: boolean }) {
  const [working, setWorking] = useState(false)
  const [result, setResult] = useState<ClaudeCodeResult | null>(null)

  const connect = async () => {
    setWorking(true)
    try {
      const outcome = await window.kificut.ai.connectClaudeCode()
      setResult(outcome)
      if (outcome.ok) {
        toast({
          kind: 'success',
          title: 'Connected to Claude Code',
          message: 'Start a new Claude Code session and ask it to edit in Kificut.'
        })
      }
    } catch (error) {
      toast({ kind: 'error', title: 'Could not connect Claude Code', message: String(error) })
    } finally {
      setWorking(false)
    }
  }

  return (
    <div className="tool">
      <div className="tool__status">
        {result?.ok ? <CircleCheck size={15} className="is-success" /> : <span className="tool__idle" />}
        <span className="tool__name">Claude Code</span>
        <span className="tool__version">{result?.ok ? 'Connected' : 'In the terminal or your editor'}</span>
      </div>
      <div className="tool__path">Adds Kificut to Claude Code in all your projects.</div>
      <div className="tool__actions">
        <Button size="sm" disabled={!enabled || working} onClick={() => void connect()}>
          {working ? 'Connecting' : 'Connect Claude Code'}
        </Button>
      </div>
      {result && !result.ok && (
        <div className="claude-code-manual">
          <p>
            {result.reason === 'not-found'
              ? 'Kificut could not find Claude Code on this computer. If it is installed, run this in a terminal:'
              : `Claude Code did not accept the change${result.error ? ` (${result.error})` : ''}. Run this in a terminal instead:`}
          </p>
          <code>{result.command}</code>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              void navigator.clipboard.writeText(result.command)
              toast({ kind: 'info', title: 'Command copied' })
            }}
          >
            Copy Command
          </Button>
        </div>
      )}
    </div>
  )
}

function UpdatePanel() {
  const status = useUpdates((s) => s.status)
  const version = window.kificut.versions.app
  let text: string
  let action: { label: string; run: () => void; primary?: boolean } | null = {
    label: 'Check Now',
    run: () => void checkForUpdates()
  }
  switch (status.state) {
    case 'unsupported':
      text = status.message
      action = null
      break
    case 'checking':
      text = 'Checking for updates'
      action = null
      break
    case 'up-to-date':
      text = 'You have the latest version.'
      break
    case 'downloading':
      text = `Downloading version ${status.version} (${Math.round(status.percent)}%)`
      action = null
      break
    case 'ready':
      text = `Version ${status.version} is ready. Unsaved work is kept.`
      action = {
        label: status.action === 'restart' ? 'Restart to Update' : 'Open Installer',
        run: () => void installUpdate(),
        primary: true
      }
      break
    case 'available':
      text = `Version ${status.version} is available.`
      action = { label: 'Download', run: () => window.kificut.shell.openExternal(status.url), primary: true }
      break
    case 'error':
      text = status.message
      break
    default:
      text = 'Not checked yet.'
  }
  return (
    <div className="tool">
      <div className="tool__status">
        {status.state === 'ready' || status.state === 'available' ? (
          <CircleAlert size={15} className="is-accent" />
        ) : status.state === 'up-to-date' ? (
          <CircleCheck size={15} className="is-success" />
        ) : (
          <span className="tool__idle" />
        )}
        <span className="tool__name">Kificut {version}</span>
      </div>
      <div className="tool__path">{text}</div>
      {action && (
        <div className="tool__actions">
          <Button size="sm" variant={action.primary ? 'primary' : 'default'} onClick={action.run}>
            {action.label}
          </Button>
        </div>
      )}
    </div>
  )
}
