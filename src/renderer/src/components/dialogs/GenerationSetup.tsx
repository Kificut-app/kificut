import { useState } from 'react'
import { CircleAlert, CircleCheck, ExternalLink, KeyRound } from 'lucide-react'
import { getService, type GenerationService, type GenerationSettingsUpdate } from '@shared/generation'
import { errorText } from '../../store/actions'
import { refreshGenerationSettings, useGeneration } from '../../store/generation'
import { Button } from '../ui/controls'

/* AI > Generation: keys for Google and fal.ai, and the ComfyUI server and workflows. */

type Check = { ok: boolean; message: string } | null

async function save(update: GenerationSettingsUpdate): Promise<void> {
  await window.kificut.generation.update(update)
  await refreshGenerationSettings()
}

function Links({ service }: { service: GenerationService }) {
  const info = getService(service)!
  return (
    <div className="generation-setup__links">
      <button
        type="button"
        className="link-button"
        onClick={() => window.kificut.shell.openExternal(info.helpUrl)}
      >
        {info.needsKey ? 'Get an API key' : 'Setup guide'} <ExternalLink size={12} />
      </button>
      {info.pricingUrl && (
        <button
          type="button"
          className="link-button"
          onClick={() => window.kificut.shell.openExternal(info.pricingUrl)}
        >
          Prices <ExternalLink size={12} />
        </button>
      )}
    </div>
  )
}

function CheckButton({ service, disabled }: { service: GenerationService; disabled: boolean }) {
  const [check, setCheck] = useState<Check>(null)
  const [busy, setBusy] = useState(false)
  const run = async () => {
    setBusy(true)
    try {
      setCheck({ ok: true, message: await window.kificut.generation.test(service) })
    } catch (e) {
      setCheck({ ok: false, message: errorText(e) })
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <Button size="sm" disabled={disabled || busy} onClick={() => void run()}>
        {busy ? 'Checking' : 'Check'}
      </Button>
      {check && (
        <p className={check.ok ? 'ai-check is-ok' : 'ai-check is-error'}>
          {check.ok ? <CircleCheck size={13} /> : <CircleAlert size={13} />} {check.message}
        </p>
      )}
    </>
  )
}

function KeyRow({
  service,
  hasKey,
  persisted,
  detail
}: {
  service: 'google' | 'fal'
  hasKey: boolean
  persisted: boolean
  detail: string
}) {
  const [key, setKey] = useState('')
  const field = service === 'google' ? 'googleKey' : 'falKey'
  const store = async () => {
    if (!key.trim()) return
    await save({ [field]: key.trim() })
    setKey('')
  }
  return (
    <div className="setting">
      <div className="setting__text">
        <span className="setting__label">API key</span>
        <span className="setting__detail">
          {hasKey
            ? persisted
              ? 'Saved and encrypted with your system key store.'
              : 'Saved for this session only: this system has no secure key store.'
            : detail}
        </span>
      </div>
      <div className="setting__control ai-key">
        {hasKey ? (
          <>
            <span className="ai-key__saved">
              <KeyRound size={13} /> Key saved
            </span>
            <Button size="sm" variant="ghost" onClick={() => void save({ [field]: null })}>
              Forget
            </Button>
          </>
        ) : (
          <>
            <input
              className="text-input"
              type="password"
              placeholder="Paste your key"
              value={key}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Enter') void store()
              }}
            />
            <Button size="sm" variant="primary" disabled={!key.trim()} onClick={() => void store()}>
              Save
            </Button>
          </>
        )}
      </div>
    </div>
  )
}

function WorkflowRow({
  label,
  path,
  field
}: {
  label: string
  path: string
  field: 'comfyuiVideoWorkflow' | 'comfyuiImageWorkflow'
}) {
  const name = path ? path.split(/[\\/]/).pop() : ''
  return (
    <div className="setting">
      <div className="setting__text">
        <span className="setting__label">{label}</span>
        <span className="setting__detail" title={path}>
          {name || 'Not chosen yet.'}
        </span>
      </div>
      <div className="setting__control ai-key">
        {path && (
          <Button size="sm" variant="ghost" onClick={() => void save({ [field]: '' })}>
            Clear
          </Button>
        )}
        <Button
          size="sm"
          onClick={() =>
            void window.kificut.generation
              .pickWorkflow()
              .then((picked) => (picked ? save({ [field]: picked }) : undefined))
          }
        >
          Choose…
        </Button>
      </div>
    </div>
  )
}

export function GenerationSetup() {
  const settings = useGeneration((s) => s.settings)
  const [url, setUrl] = useState<string | null>(null)
  const [urlError, setUrlError] = useState('')
  if (!settings) return null
  const address = url ?? settings.comfyuiUrl

  return (
    <div className="ai-dialog__section generation-setup">
      <p className="settings__note">
        Make scenes and pictures in the Generate tab next to Voice. Google and fal.ai run in the cloud with
        your own key and bill your account for each clip or picture; Kificut shows the expected cost before
        you start. ComfyUI runs on your own graphics card for free. Keys are stored encrypted and only sent to
        their service.
      </p>

      <h3 className="settings__heading">Google</h3>
      <p className="ai-dialog__use">{getService('google')!.hint}</p>
      <KeyRow
        service="google"
        hasKey={settings.googleKey}
        persisted={settings.keysPersisted}
        detail="The same Gemini API key the Assistant uses for Google Gemini."
      />
      <div className="generation-setup__row">
        <Links service="google" />
        <CheckButton service="google" disabled={!settings.googleKey} />
      </div>

      <h3 className="settings__heading">fal.ai</h3>
      <p className="ai-dialog__use">{getService('fal')!.hint}</p>
      <KeyRow
        service="fal"
        hasKey={settings.falKey}
        persisted={settings.keysPersisted}
        detail="Stored encrypted on this computer and only sent to fal.ai."
      />
      <div className="generation-setup__row">
        <Links service="fal" />
        <CheckButton service="fal" disabled={!settings.falKey} />
      </div>

      <h3 className="settings__heading">ComfyUI</h3>
      <p className="ai-dialog__use">{getService('comfyui')!.hint}</p>
      <div className="setting">
        <div className="setting__text">
          <span className="setting__label">Server address</span>
          <span className="setting__detail">
            {urlError || 'Where ComfyUI is running, usually on this computer.'}
          </span>
        </div>
        <div className="setting__control ai-key">
          <input
            className="text-input"
            placeholder="http://127.0.0.1:8188"
            value={address}
            spellCheck={false}
            onChange={(e) => setUrl(e.target.value)}
            onBlur={() => {
              if (address === settings.comfyuiUrl) return
              setUrlError('')
              void save({ comfyuiUrl: address })
                .then(() => setUrl(null))
                .catch((e: unknown) => setUrlError(errorText(e)))
            }}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            }}
          />
        </div>
      </div>
      <WorkflowRow label="Video workflow" path={settings.comfyuiVideoWorkflow} field="comfyuiVideoWorkflow" />
      <WorkflowRow
        label="Picture workflow"
        path={settings.comfyuiImageWorkflow}
        field="comfyuiImageWorkflow"
      />
      <div className="generation-setup__row">
        <Links service="comfyui" />
        <CheckButton service="comfyui" disabled={!settings.comfyuiUrl} />
      </div>
      <p className="ai-dialog__fine">
        Export each workflow with Workflow &gt; Export (API) and put these placeholders where Kificut should
        fill in values: <code>{'{{prompt}}'}</code>, <code>{'{{negative_prompt}}'}</code>,{' '}
        <code>{'{{width}}'}</code>, <code>{'{{height}}'}</code>, <code>{'{{frames}}'}</code>,{' '}
        <code>{'{{fps}}'}</code>, <code>{'{{seconds}}'}</code>, <code>{'{{seed}}'}</code> and{' '}
        <code>{'{{image}}'}</code> (the starting picture, for a LoadImage node).
      </p>
    </div>
  )
}
