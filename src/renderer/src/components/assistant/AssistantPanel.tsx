import { useEffect, useLayoutEffect, useRef } from 'react'
import { ArrowUp, Check, CircleAlert, Loader2, Settings2, Sparkles, Square, SquarePen } from 'lucide-react'
import {
  activeLabel,
  newChat,
  sendToAssistant,
  stopAssistant,
  useAssistant,
  type ChatItem
} from '../../store/assistant'
import { openAiDialog } from '../dialogs/AiDialog'
import { Button, IconButton, cx } from '../ui/controls'

const IDEAS = [
  'Add captions to the interview',
  'Cut the silences from the first clip',
  'Put a title that says "Day One" at the start',
  'Make a 30 second highlight cut'
]

export function AssistantPanel() {
  const settings = useAssistant((s) => s.settings)
  const items = useAssistant((s) => s.items)
  const busy = useAssistant((s) => s.busy)
  const label = activeLabel(settings)

  if (settings && !settings.active) {
    return (
      <div className="assistant assistant--empty">
        <div className="assistant__intro">
          <Sparkles size={20} />
          <h3>Edit by asking</h3>
          <p>
            Connect an AI provider with your own API key, or a model running on your computer, and describe
            the edit you want. You can watch every change and undo it.
          </p>
          <Button variant="primary" size="sm" onClick={() => openAiDialog('assistant')}>
            Connect a Provider
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="assistant">
      <div className="assistant__bar">
        <span className="assistant__model" data-tip={label ?? undefined}>
          {label ?? 'Assistant'}
        </span>
        <IconButton size="sm" tip="New chat" disabled={items.length === 0 && !busy} onClick={newChat}>
          <SquarePen size={14} />
        </IconButton>
        <IconButton size="sm" tip="Assistant settings" onClick={() => openAiDialog('assistant')}>
          <Settings2 size={14} />
        </IconButton>
      </div>
      <Messages items={items} busy={busy} />
      <Composer busy={busy} />
    </div>
  )
}

function Messages({ items, busy }: { items: ChatItem[]; busy: boolean }) {
  const ref = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
  }, [items, busy])

  if (items.length === 0) {
    return (
      <div className="assistant__messages assistant__messages--ideas">
        <p className="assistant__hint">Try asking:</p>
        {IDEAS.map((idea) => (
          <button
            key={idea}
            type="button"
            className="assistant__idea"
            onClick={() => useAssistant.setState({ draft: idea })}
          >
            {idea}
          </button>
        ))}
      </div>
    )
  }

  const last = items[items.length - 1]
  const thinking = busy && (last.kind === 'user' || (last.kind === 'tool' && last.state !== 'running'))

  return (
    <div ref={ref} className="assistant__messages">
      {items.map((item) => {
        switch (item.kind) {
          case 'user':
            return (
              <div key={item.id} className="chat chat--user">
                {item.text}
              </div>
            )
          case 'assistant':
            return (
              <div key={item.id} className="chat chat--assistant">
                {item.text.trim()}
              </div>
            )
          case 'tool':
            return (
              <div
                key={item.id}
                className={cx('chat-tool', `is-${item.state}`)}
                data-tip={item.summary || undefined}
              >
                {item.state === 'running' ? (
                  <Loader2 size={12} className="spin" />
                ) : item.state === 'ok' ? (
                  <Check size={12} />
                ) : (
                  <CircleAlert size={12} />
                )}
                <span className="chat-tool__title">{item.title}</span>
                {item.summary && <span className="chat-tool__summary">{item.summary}</span>}
              </div>
            )
          case 'notice':
            return (
              <div key={item.id} className={cx('chat-notice', item.error && 'is-error')}>
                {item.text}
              </div>
            )
        }
      })}
      {thinking && (
        <div className="chat-thinking">
          <span />
          <span />
          <span />
        </div>
      )}
    </div>
  )
}

function Composer({ busy }: { busy: boolean }) {
  const draft = useAssistant((s) => s.draft)
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(160, el.scrollHeight)}px`
  }, [draft])

  const send = () => void sendToAssistant(draft)

  return (
    <div className="assistant__composer">
      <textarea
        ref={ref}
        rows={1}
        value={draft}
        placeholder="Describe an edit"
        onChange={(e) => useAssistant.setState({ draft: e.target.value })}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            if (!busy) send()
          }
        }}
      />
      {busy ? (
        <IconButton tip="Stop" className="assistant__send" onClick={stopAssistant}>
          <Square size={12} fill="currentColor" />
        </IconButton>
      ) : (
        <IconButton tip="Send|Enter" className="assistant__send" disabled={!draft.trim()} onClick={send}>
          <ArrowUp size={15} />
        </IconButton>
      )}
    </div>
  )
}
