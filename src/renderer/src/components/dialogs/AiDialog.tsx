import { useEffect, useState } from 'react'
import { AudioLines, Captions, CircleAlert, CircleCheck, ExternalLink, KeyRound } from 'lucide-react'
import { LOCAL_MODELS, type LocalModelInfo } from '@shared/models'
import { getProvider, PROVIDERS, type AssistantSettings, type ProviderId } from '@shared/assistant'
import { setDialog } from '../../store/editor'
import { errorText } from '../../store/actions'
import { cancelModelInstall, formatBytes, installModel, removeModel, useModels } from '../../store/models'
import { toast, useUi } from '../../store/ui'
import { useAssistant } from '../../store/assistant'
import { Button, Segmented, Select } from '../ui/controls'
import { Modal } from '../ui/overlays'

type AiTab = 'models' | 'assistant'

export function openAiDialog(tab: AiTab = 'models'): void {
  useUi.setState({ aiTab: tab })
  setDialog('ai')
}

export function AiDialog() {
  const tab = useUi((s) => s.aiTab)
  return (
    <Modal title="AI" onClose={() => setDialog(null)} width={640}>
      <div className="ai-dialog">
        <Segmented<AiTab>
          value={tab}
          onChange={(aiTab) => useUi.setState({ aiTab })}
          options={[
            { value: 'models', label: 'Models on this computer' },
            { value: 'assistant', label: 'Assistant' }
          ]}
        />
        {tab === 'models' ? <LocalModels /> : <AssistantSetup />}
      </div>
    </Modal>
  )
}

/* Local models */

function LocalModels() {
  return (
    <div className="ai-dialog__section">
      <p className="settings__note">
        These models run on your computer, so your footage and scripts stay private and they work offline once
        installed. Files come from Hugging Face and are checked against their published hashes.
      </p>
      <h3 className="settings__heading">Voiceover</h3>
      {LOCAL_MODELS.filter((m) => m.task === 'voiceover').map((m) => (
        <ModelRow key={m.id} model={m} />
      ))}
      <h3 className="settings__heading">Speech to text</h3>
      {LOCAL_MODELS.filter((m) => m.task === 'transcription').map((m) => (
        <ModelRow key={m.id} model={m} />
      ))}
      <p className="ai-dialog__fine">
        Kokoro turns text into sounds with eSpeak NG, which is licensed under the GPL. It is downloaded
        together with the model rather than shipped inside Kificut.
      </p>
    </div>
  )
}

function ModelRow({ model }: { model: LocalModelInfo }) {
  const status = useModels((s) => s[model.id])
  const state = status?.state ?? 'not-installed'
  const percent = status && status.total > 0 ? Math.min(100, (status.received / status.total) * 100) : 0
  const Icon = model.task === 'voiceover' ? AudioLines : Captions

  return (
    <div className="model-row">
      <div className="model-row__icon">
        <Icon size={16} />
      </div>
      <div className="model-row__text">
        <div className="model-row__title">
          <span className="model-row__name">{model.name}</span>
          <span className="model-row__meta">
            {state === 'installed' ? formatBytes(status!.size) : formatBytes(model.approximateSize)} ·{' '}
            {model.license}
          </span>
        </div>
        <p className="model-row__description">{model.description}</p>
        {state === 'downloading' && (
          <div className="model-row__progress">
            <div className="progress">
              <span style={{ width: `${percent}%` }} />
            </div>
            <span>
              {formatBytes(status!.received)} of {formatBytes(status!.total)}
            </span>
          </div>
        )}
        {state === 'error' && (
          <p className="model-row__error">
            <CircleAlert size={13} /> {status?.error}
          </p>
        )}
      </div>
      <div className="model-row__actions">
        {state === 'installed' && (
          <>
            <span className="model-row__ok">
              <CircleCheck size={14} /> Installed
            </span>
            <Button size="sm" variant="ghost" onClick={() => removeModel(model.id)}>
              Remove
            </Button>
          </>
        )}
        {state === 'downloading' && (
          <Button size="sm" onClick={() => cancelModelInstall(model.id)}>
            Cancel
          </Button>
        )}
        {(state === 'not-installed' || state === 'error') && (
          <Button size="sm" variant="primary" onClick={() => installModel(model.id)}>
            {state === 'error' ? 'Try Again' : 'Install'}
          </Button>
        )}
      </div>
    </div>
  )
}

/* Assistant provider */

function AssistantSetup() {
  const [settings, setLocalSettings] = useState<AssistantSettings | null>(null)
  const [selected, setSelected] = useState<ProviderId>('anthropic')

  useEffect(() => {
    void window.kificut.assistant.settings().then((s) => {
      setLocalSettings(s)
      if (s.active) setSelected(s.active)
    })
  }, [])

  const setSettings = (next: AssistantSettings) => {
    const before = useAssistant.getState().settings
    const model = (s: AssistantSettings | null) => s?.providers.find((p) => p.id === s.active)?.model
    // Kificut starts a new conversation when the provider or model changes.
    if (before && (before.active !== next.active || model(before) !== model(next))) {
      useAssistant.setState({ items: [] })
    }
    useAssistant.setState({ settings: next })
    setLocalSettings(next)
  }

  if (!settings) return null
  const preset = getProvider(selected)!
  const state = settings.providers.find((p) => p.id === selected)!

  return (
    <div className="ai-dialog__section">
      <p className="settings__note">
        The assistant edits with you from the Assistant tab next to the Inspector. Connect it to an AI
        provider with your own API key, or to a model running on your computer.
      </p>
      <div className="setting">
        <div className="setting__text">
          <span className="setting__label">Provider</span>
          <span className="setting__detail">{preset.hint}</span>
        </div>
        <div className="setting__control">
          <Select<ProviderId>
            value={selected}
            onChange={setSelected}
            options={PROVIDERS.map((p) => ({
              value: p.id,
              label: settings.active === p.id ? `${p.name} (in use)` : p.name
            }))}
          />
        </div>
      </div>
      <ProviderForm
        key={selected}
        id={selected}
        settings={settings}
        onChange={setSettings}
        active={settings.active === selected}
        state={state}
      />
    </div>
  )
}

function ProviderForm({
  id,
  state,
  active,
  onChange
}: {
  id: ProviderId
  settings: AssistantSettings
  state: AssistantSettings['providers'][number]
  active: boolean
  onChange: (settings: AssistantSettings) => void
}) {
  const preset = getProvider(id)!
  const [key, setKey] = useState('')
  const [baseUrl, setBaseUrl] = useState(state.baseUrl)
  const [model, setModel] = useState(state.model)
  const [models, setModels] = useState<Array<{ id: string; name: string }>>([])
  const [checking, setChecking] = useState(false)
  const [check, setCheck] = useState<{ ok: boolean; message: string } | null>(null)

  const save = async (patch: { apiKey?: string | null; baseUrl?: string; model?: string }) => {
    try {
      const next = await window.kificut.assistant.updateProvider({ id, ...patch })
      onChange(next)
      return next
    } catch (error) {
      toast({ kind: 'error', title: 'Could not save', message: errorText(error) })
      return null
    }
  }

  const loadModels = async () => {
    setChecking(true)
    setCheck(null)
    try {
      const list = await window.kificut.assistant.listModels(id)
      setModels(list)
      setCheck({
        ok: true,
        message: list.length
          ? `Connected. ${list.length} ${list.length === 1 ? 'model' : 'models'} available.`
          : 'Connected.'
      })
      if (!model && list.length) {
        setModel(list[0].id)
        await save({ model: list[0].id })
      }
    } catch (error) {
      setCheck({ ok: false, message: errorText(error) })
    } finally {
      setChecking(false)
    }
  }

  const saveKey = async () => {
    if (!key.trim()) return
    const next = await save({ apiKey: key })
    if (next) {
      setKey('')
      await loadModels()
    }
  }

  const ready = (!preset.needsKey || state.hasKey) && Boolean(state.baseUrl) && Boolean(model)

  return (
    <>
      {preset.needsKey && (
        <div className="setting">
          <div className="setting__text">
            <span className="setting__label">API key</span>
            <span className="setting__detail">
              {state.hasKey
                ? state.keyPersisted
                  ? 'Saved and encrypted with your system key store.'
                  : 'Saved for this session only: this system has no secure key store.'
                : 'Stored encrypted on this computer and only sent to this provider.'}
            </span>
          </div>
          <div className="setting__control ai-key">
            {state.hasKey ? (
              <>
                <span className="ai-key__saved">
                  <KeyRound size={13} /> Key saved
                </span>
                <Button size="sm" variant="ghost" onClick={() => void save({ apiKey: null })}>
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
                    if (e.key === 'Enter') void saveKey()
                  }}
                />
                <Button size="sm" variant="primary" disabled={!key.trim()} onClick={() => void saveKey()}>
                  Save
                </Button>
              </>
            )}
          </div>
        </div>
      )}

      {preset.editableUrl && (
        <div className="setting">
          <div className="setting__text">
            <span className="setting__label">Server address</span>
            <span className="setting__detail">The base URL, ending before /chat/completions.</span>
          </div>
          <div className="setting__control ai-key">
            <input
              className="text-input"
              placeholder="http://localhost:8000/v1"
              value={baseUrl}
              spellCheck={false}
              onChange={(e) => setBaseUrl(e.target.value)}
              onBlur={() => baseUrl !== state.baseUrl && void save({ baseUrl })}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              }}
            />
          </div>
        </div>
      )}

      {!preset.needsKey && preset.id === 'custom' && (
        <div className="setting">
          <div className="setting__text">
            <span className="setting__label">API key</span>
            <span className="setting__detail">Only if your server asks for one.</span>
          </div>
          <div className="setting__control ai-key">
            {state.hasKey ? (
              <Button size="sm" variant="ghost" onClick={() => void save({ apiKey: null })}>
                Forget key
              </Button>
            ) : (
              <input
                className="text-input"
                type="password"
                placeholder="Optional"
                value={key}
                autoComplete="off"
                onChange={(e) => setKey(e.target.value)}
                onBlur={() => key.trim() && void saveKey()}
                onKeyDown={(e) => e.stopPropagation()}
              />
            )}
          </div>
        </div>
      )}

      <div className="setting">
        <div className="setting__text">
          <span className="setting__label">Model</span>
          <span className="setting__detail">
            {preset.id === 'anthropic'
              ? 'Claude Opus 5.5 gives the best results.'
              : 'Pick a model that supports tool calling.'}
          </span>
        </div>
        <div className="setting__control ai-key">
          <input
            className="text-input"
            list={`models-${id}`}
            placeholder="Model id"
            value={model}
            spellCheck={false}
            onChange={(e) => setModel(e.target.value)}
            onBlur={() => model !== state.model && void save({ model })}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            }}
          />
          <datalist id={`models-${id}`}>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name !== m.id ? m.name : undefined}
              </option>
            ))}
          </datalist>
          <Button
            size="sm"
            disabled={checking || (preset.needsKey && !state.hasKey) || !state.baseUrl}
            onClick={() => void loadModels()}
          >
            {checking ? 'Checking' : 'Check'}
          </Button>
        </div>
      </div>

      {check && (
        <p className={check.ok ? 'ai-check is-ok' : 'ai-check is-error'}>
          {check.ok ? <CircleCheck size={13} /> : <CircleAlert size={13} />} {check.message}
        </p>
      )}

      <div className="ai-dialog__footer">
        {preset.helpUrl ? (
          <button
            type="button"
            className="link-button"
            onClick={() => window.kificut.shell.openExternal(preset.helpUrl)}
          >
            {preset.needsKey ? 'Get an API key' : 'Setup guide'} <ExternalLink size={12} />
          </button>
        ) : (
          <span />
        )}
        {active ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void window.kificut.assistant.setActive(null).then(onChange)}
          >
            Stop using {preset.name}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="primary"
            disabled={!ready}
            onClick={() =>
              void window.kificut.assistant.setActive(id).then((next) => {
                onChange(next)
                toast({ kind: 'success', title: `The assistant now uses ${preset.name}` })
              })
            }
          >
            Use This Provider
          </Button>
        )}
      </div>
      <p className="ai-dialog__fine">
        When you chat, your messages, project details and any frames the assistant looks at are sent to{' '}
        {preset.protocol === 'openai' && !preset.needsKey ? 'the server above' : preset.name}.
        {preset.id === 'anthropic' &&
          ' If Claude declines a request, Anthropic may answer it with another Claude model instead.'}
      </p>
    </>
  )
}
