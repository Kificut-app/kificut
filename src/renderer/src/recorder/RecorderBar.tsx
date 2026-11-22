import { useEffect, useRef, useState } from 'react'
import { Pause, Play, Square, Trash2 } from 'lucide-react'
import {
  formatClock,
  RECORDING_SHORTCUTS,
  shortcutLabel,
  type RecorderCommand,
  type RecorderPhase,
  type RecorderStatus
} from '@shared/recording'
import { openStreams, Recording } from './pipeline'

/*
 * The recorder window. It opens the sources, counts down, records and shows a small bar with the
 * time, the microphone level and the controls. The same controls are in the tray and on global
 * shortcuts, so the bar can be hidden where it would show up in the recording.
 */

const mac = window.kificut.platform === 'darwin'
const STOP_KEYS = shortcutLabel(RECORDING_SHORTCUTS.stop, mac)
const PAUSE_KEYS = shortcutLabel(RECORDING_SHORTCUTS.pause, mac)

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Everything the window does, outside React so it runs once even when React renders twice. */
class Controller {
  phase: RecorderPhase = 'preparing'
  countdown = 0
  recording: Recording | null = null
  private finishing = false
  private cancelled = false
  private reporter: number | null = null
  onChange: () => void = () => undefined

  status(): RecorderStatus {
    return {
      phase: this.phase,
      elapsed: this.recording?.elapsed ?? 0,
      countdown: this.countdown,
      level: this.recording?.level ?? null
    }
  }

  private set(phase: RecorderPhase): void {
    this.phase = phase
    window.kificut.recorder.report(this.status())
    this.onChange()
  }

  async begin(): Promise<void> {
    try {
      const session = await window.kificut.recorder.session()
      const streams = await openStreams(session)
      const recording = new Recording(session, streams)
      this.recording = recording
      recording.onSourceEnded = (what) => {
        // A recorded window was closed or a camera unplugged: keep what was recorded.
        if (this.phase === 'recording' || this.phase === 'paused') void this.stop()
        else
          void this.fail(
            `The ${what === 'screen' ? 'screen or window' : what} stopped before the recording started.`
          )
      }
      recording.onFailure = (error) => void this.fail(error.message)
      await recording.prepare()

      const seconds = session.options.countdown
      if (seconds > 0) {
        await window.kificut.recorder.layout('countdown')
        this.countdown = seconds
        this.set('countdown')
        for (let n = seconds; n > 0; n--) {
          this.countdown = n
          window.kificut.recorder.report(this.status())
          this.onChange()
          await sleep(1000)
          if (this.cancelled) return
        }
      }
      if (this.cancelled) return
      this.countdown = 0
      await window.kificut.recorder.layout(session.options.showControls ? 'bar' : 'hidden')
      await recording.start()
      this.set('recording')
      this.reporter = window.setInterval(() => {
        window.kificut.recorder.report(this.status())
        this.onChange()
      }, 200)
    } catch (error) {
      await this.fail(errorMessage(error))
    }
  }

  private async fail(message: string): Promise<void> {
    if (this.finishing) return
    this.finishing = true
    if (this.reporter !== null) clearInterval(this.reporter)
    await this.recording?.discard().catch(() => undefined)
    await window.kificut.recorder.fail(message)
  }

  command(command: RecorderCommand): void {
    if (command === 'stop')
      void (this.phase === 'countdown' || this.phase === 'preparing' ? this.discard() : this.stop())
    else if (command === 'discard') void this.discard()
    else if (command === 'pause' || (command === 'toggle-pause' && this.phase === 'recording')) this.pause()
    else if (command === 'resume' || (command === 'toggle-pause' && this.phase === 'paused')) this.resume()
  }

  pause(): void {
    if (this.phase !== 'recording') return
    this.recording?.pause()
    this.set('paused')
  }

  resume(): void {
    if (this.phase !== 'paused') return
    this.recording?.resume()
    this.set('recording')
  }

  async stop(): Promise<void> {
    if (this.finishing || !this.recording) return
    this.finishing = true
    if (this.reporter !== null) clearInterval(this.reporter)
    this.set('saving')
    try {
      const duration = await this.recording.stop()
      console.info('Recorder frames', JSON.stringify(this.recording.stats()))
      await window.kificut.recorder.finish({ duration })
    } catch (error) {
      this.finishing = false
      await this.fail(errorMessage(error))
    }
  }

  async discard(): Promise<void> {
    if (this.finishing) return
    this.finishing = true
    this.cancelled = true
    if (this.reporter !== null) clearInterval(this.reporter)
    await this.recording?.discard().catch(() => undefined)
    await window.kificut.recorder.discarded()
  }
}

let controller: Controller | null = null

function useController(): Controller {
  const [, render] = useState(0)
  if (!controller) {
    controller = new Controller()
    void controller.begin()
    window.kificut.recorder.onCommand((command) => controller!.command(command))
  }
  useEffect(() => {
    controller!.onChange = () => render((n) => n + 1)
    return () => {
      controller!.onChange = () => undefined
    }
  }, [])
  return controller
}

function LevelMeter({ level }: { level: number }) {
  // Five bars on a rough decibel scale, so speech fills three or four of them.
  const db = level > 0 ? 20 * Math.log10(level) : -100
  const lit = Math.max(0, Math.min(5, Math.round((db + 50) / 10)))
  return (
    <div className="rec-meter" aria-label="Microphone level">
      {[0, 1, 2, 3, 4].map((i) => (
        <span key={i} className={i < lit ? (i >= 4 ? 'is-hot' : 'is-on') : ''} />
      ))}
    </div>
  )
}

export function RecorderBar() {
  const c = useController()
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const discardTimer = useRef<number | null>(null)
  const { phase, countdown } = c
  const elapsed = c.recording?.elapsed ?? 0
  const level = c.recording?.level ?? null

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && (phase === 'countdown' || phase === 'preparing')) c.command('discard')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [c, phase])

  if (phase === 'countdown') {
    return (
      <div className="rec-countdown">
        <div className="rec-countdown__ring">
          <span className="rec-countdown__number" key={countdown}>
            {countdown}
          </span>
        </div>
        <button type="button" className="rec-countdown__cancel" onClick={() => c.command('discard')}>
          Cancel
        </button>
      </div>
    )
  }

  if (phase === 'preparing') {
    return (
      <div className="rec-bar rec-bar--quiet">
        <span className="rec-spinner" />
        <span className="rec-bar__label">Getting ready</span>
      </div>
    )
  }

  if (phase === 'saving') {
    return (
      <div className="rec-bar rec-bar--quiet">
        <span className="rec-spinner" />
        <span className="rec-bar__label">Saving recording</span>
      </div>
    )
  }

  const paused = phase === 'paused'
  const askDiscard = () => {
    if (confirmDiscard) {
      void c.discard()
      return
    }
    setConfirmDiscard(true)
    if (discardTimer.current) clearTimeout(discardTimer.current)
    discardTimer.current = window.setTimeout(() => setConfirmDiscard(false), 3000)
  }

  return (
    <div className={`rec-bar${paused ? ' is-paused' : ''}`}>
      <div className="rec-bar__time" title={paused ? 'Paused' : 'Recording'}>
        <span className={`rec-dot${paused ? ' rec-dot--paused' : ''}`} />
        <span className="rec-bar__clock">{formatClock(elapsed)}</span>
      </div>
      {level !== null && <LevelMeter level={level} />}
      <div className="rec-bar__buttons">
        <button
          type="button"
          className="rec-button"
          title={`${paused ? 'Resume' : 'Pause'} (${PAUSE_KEYS})`}
          aria-label={paused ? 'Resume' : 'Pause'}
          onClick={() => c.command('toggle-pause')}
        >
          {paused ? <Play size={15} /> : <Pause size={15} />}
        </button>
        <button
          type="button"
          className="rec-button rec-button--stop"
          title={`Stop and save (${STOP_KEYS})`}
          onClick={() => c.command('stop')}
        >
          <Square size={12} fill="currentColor" />
          <span>Stop</span>
        </button>
        <button
          type="button"
          className={`rec-button rec-button--discard${confirmDiscard ? ' is-confirming' : ''}`}
          title={confirmDiscard ? 'Click again to discard' : 'Discard recording'}
          aria-label="Discard recording"
          onClick={askDiscard}
        >
          {confirmDiscard ? <span>Discard?</span> : <Trash2 size={15} />}
        </button>
      </div>
    </div>
  )
}
