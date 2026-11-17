import { LOCAL_MODELS, type ModelTask } from '@shared/models'
import type { ToolResult } from '@shared/ai-tools'
import { runTool } from '../ai/tools'
import { useModels } from '../store/models'
import { toast } from '../store/ui'
import { openAiDialog } from '../components/dialogs/AiDialog'

/* Local AI features started from Kificut's own buttons and menus. */

function hasModel(task: ModelTask): boolean {
  const statuses = useModels.getState()
  return LOCAL_MODELS.some((m) => m.task === task && statuses[m.id]?.state === 'installed')
}

function askToInstall(task: ModelTask): void {
  toast({
    kind: 'info',
    title: task === 'voiceover' ? 'Install the voice model first' : 'Install a speech model first',
    message:
      task === 'voiceover'
        ? 'Kokoro creates voiceovers on this computer. It is a one time download.'
        : 'Whisper turns speech into captions on this computer. It is a one time download.',
    action: { label: 'Open AI Models', run: () => openAiDialog('models') }
  })
}

function firstLine(result: ToolResult): string {
  const text = result.content.find((c) => c.type === 'text')
  return text?.type === 'text' ? text.text.split('\n')[0] : ''
}

export async function generateCaptions(clipId: string): Promise<void> {
  if (!hasModel('transcription')) return askToInstall('transcription')
  const result = await runTool('add_captions', { clip_id: clipId })
  if (result.isError) toast({ kind: 'error', title: 'Could not add captions', message: firstLine(result) })
  else toast({ kind: 'success', title: 'Captions added', message: firstLine(result) })
}

export async function generateVoiceover(text: string, voice: string, speed: number): Promise<boolean> {
  if (!hasModel('voiceover')) {
    askToInstall('voiceover')
    return false
  }
  const result = await runTool('generate_voiceover', { text, voice, speed })
  if (result.isError) {
    toast({ kind: 'error', title: 'Could not create the voiceover', message: firstLine(result) })
    return false
  }
  toast({
    kind: 'success',
    title: 'Voiceover added',
    message: firstLine(result).replace(/ The file is .*$/, '')
  })
  return true
}
