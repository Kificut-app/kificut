import { LOCAL_MODELS, type ModelTask } from '@shared/models'
import { isCustomVoiceId } from '@shared/voices'
import type { ToolResult } from '@shared/ai-tools'
import { runTool } from '../ai/tools'
import { useModels } from '../store/models'
import { toast } from '../store/ui'
import { openAiDialog } from '../components/dialogs/AiDialog'

/* Local AI features started from Kificut's own buttons and menus. They share the tools' code. */

function hasModel(task: ModelTask, only?: string): boolean {
  const statuses = useModels.getState()
  return LOCAL_MODELS.some(
    (m) => m.task === task && (!only || m.id === only) && statuses[m.id]?.state === 'installed'
  )
}

const INSTALL_HINT: Record<ModelTask, { title: string; message: string }> = {
  voiceover: {
    title: 'Install the voice model first',
    message: 'Kokoro creates voiceovers on this computer. It is a one time download.'
  },
  'voice-clone': {
    title: 'Install the custom voice model first',
    message: 'Chatterbox Turbo speaks in your own voices on this computer. It is a one time download.'
  },
  transcription: {
    title: 'Install a speech model first',
    message: 'Whisper turns speech into captions on this computer. It is a one time download.'
  },
  noise: {
    title: 'Install the noise reduction model first',
    message: 'RNNoise cleans up speech on this computer. It is a download of under 1 MB.'
  },
  search: {
    title: 'Install the search model first',
    message: 'CLIP lets you search your footage by what it shows. It is a one time download.'
  },
  background: {
    title: 'Install a background removal model first',
    message: 'MODNet works on people in video and pictures; ORMBG on any subject in pictures.'
  }
}

export function askToInstall(task: ModelTask): void {
  toast({
    kind: 'info',
    ...INSTALL_HINT[task],
    action: { label: 'Open AI Models', run: () => openAiDialog('models') }
  })
}

function firstLine(result: ToolResult): string {
  const text = result.content.find((c) => c.type === 'text')
  return text?.type === 'text' ? text.text.split('\n')[0] : ''
}

async function runWithToasts(
  name: string,
  args: Record<string, unknown>,
  failure: string,
  success: string
): Promise<boolean> {
  const result = await runTool(name, args)
  if (result.isError) {
    toast({ kind: 'error', title: failure, message: firstLine(result) })
    return false
  }
  toast({
    kind: 'success',
    title: success,
    message: firstLine(result).replace(/,? saved at .*$| The file is .*$/, '')
  })
  return true
}

export async function generateCaptions(clipId: string, translate = false): Promise<void> {
  if (!hasModel('transcription')) return askToInstall('transcription')
  await runWithToasts(
    'add_captions',
    { clip_id: clipId, translate_to_english: translate },
    'Could not add captions',
    translate ? 'English captions added' : 'Captions added'
  )
}

export async function reduceNoise(clipId: string): Promise<void> {
  if (!hasModel('noise')) return askToInstall('noise')
  await runWithToasts('reduce_noise', { clip_id: clipId }, 'Could not reduce the noise', 'Noise reduced')
}

export async function removeBackground(clipId: string, isVideo: boolean): Promise<void> {
  if (isVideo ? !hasModel('background', 'modnet') : !hasModel('background')) return askToInstall('background')
  await runWithToasts(
    'remove_background',
    { clip_id: clipId },
    'Could not remove the background',
    'Background removed'
  )
}

export async function generateVoiceover(text: string, voice: string, speed: number): Promise<boolean> {
  const task: ModelTask = isCustomVoiceId(voice) ? 'voice-clone' : 'voiceover'
  if (!hasModel(task)) {
    askToInstall(task)
    return false
  }
  return runWithToasts(
    'generate_voiceover',
    { text, voice, speed },
    'Could not create the voiceover',
    'Voiceover added'
  )
}
