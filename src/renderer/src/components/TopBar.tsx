import { useEffect, useRef, useState } from 'react'
import { Download, Loader2, Redo2, Settings, Sparkles, Undo2 } from 'lucide-react'
import { isDirty, redo, setDialog, undo, useEditor } from '../store/editor'
import { renameProject, saveProject } from '../store/actions'
import { useUi } from '../store/ui'
import { openAiDialog } from './dialogs/AiDialog'
import { Button, IconButton, cx } from './ui/controls'
import { LogoMark } from './Logo'
import { modKey } from '../lib/platform'

export function TopBar() {
  const project = useEditor((s) => s.project)
  const dirty = useEditor((s) => isDirty(s))
  const hasFile = useEditor((s) => !!s.filePath)
  const canUndo = useEditor((s) => s.past.length > 0)
  const canRedo = useEditor((s) => s.future.length > 0)
  const platform = window.kificut.platform

  return (
    <header className={`topbar topbar--${platform}`}>
      <div className="topbar__brand">
        <LogoMark size={18} />
        <span className="topbar__name">Kificut</span>
      </div>

      {project && (
        <>
          <span className="topbar__divider" />
          <ProjectTitle name={project.name} />
          <button
            type="button"
            className="topbar__status"
            data-tip={`Save|${modKey}S`}
            disabled={hasFile && !dirty}
            onClick={() => void saveProject()}
          >
            {!hasFile ? 'Not saved' : dirty ? 'Edited' : 'Saved'}
          </button>

          <div className="topbar__spacer" />

          <TaskChip />
          <AiChip />

          <div className="topbar__actions">
            <IconButton tip={`Undo|${modKey}Z`} onClick={undo} disabled={!canUndo}>
              <Undo2 size={16} />
            </IconButton>
            <IconButton
              tip={`Redo|${modKey}${platform === 'darwin' ? '⇧Z' : 'Y'}`}
              onClick={redo}
              disabled={!canRedo}
            >
              <Redo2 size={16} />
            </IconButton>
            <IconButton tip="AI models and assistant" onClick={() => openAiDialog()}>
              <Sparkles size={16} />
            </IconButton>
            <IconButton tip="Settings" onClick={() => setDialog('preferences')}>
              <Settings size={16} />
            </IconButton>
            <Button
              variant="primary"
              size="sm"
              icon={<Download size={14} />}
              tip={`Export|${modKey}E`}
              onClick={() => setDialog('export')}
            >
              Export
            </Button>
          </div>
        </>
      )}
      {!project && <div className="topbar__spacer" />}
    </header>
  )
}

function ProjectTitle({ name }: { name: string }) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(name)
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => setValue(name), [name])
  useEffect(() => {
    if (editing) ref.current?.select()
  }, [editing])

  const finish = () => {
    setEditing(false)
    if (value.trim() && value !== name) renameProject(value)
    else setValue(name)
  }

  if (editing) {
    return (
      <input
        ref={ref}
        className="topbar__title-input"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={finish}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') finish()
          if (e.key === 'Escape') {
            setValue(name)
            setEditing(false)
          }
        }}
      />
    )
  }
  return (
    <button
      type="button"
      className="topbar__title"
      data-tip="Rename project"
      onClick={() => setEditing(true)}
    >
      {name}
    </button>
  )
}

function TaskChip() {
  const tasks = useUi((s) => s.tasks)
  if (tasks.length === 0) return null
  const task = tasks[tasks.length - 1]
  const more = tasks.length > 1 ? ` (+${tasks.length - 1})` : ''
  return (
    <div className="task-chip" role="status">
      <Loader2 size={12} className="spin" />
      <span>
        {task.label}
        {task.status ? `: ${task.status}` : ''}
        {more}
      </span>
    </div>
  )
}

function AiChip() {
  const status = useUi((s) => s.ai.status)
  const activity = useUi((s) => s.ai.activity)
  if (!status?.connected) return null
  const client = status.client ?? 'Assistant'
  return (
    <button
      type="button"
      className={cx('ai-chip', activity && 'is-busy')}
      data-tip={
        activity ? `${client} is working: ${activity}` : `${client} is connected and can edit this project`
      }
      onClick={() => setDialog('preferences')}
    >
      <span className="ai-chip__dot" />
      <span>{activity ? `${client}: ${activity}` : client}</span>
    </button>
  )
}
