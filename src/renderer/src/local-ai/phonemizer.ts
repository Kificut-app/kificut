import { MODELS_URL, PHONEMIZER_PATH } from '@shared/models'

/*
 * Stands in for the "phonemizer" package that kokoro-js imports. The real module embeds eSpeak NG,
 * which is GPL licensed, so Kificut does not ship it: it is downloaded with the Kokoro model and
 * loaded from there.
 */

type PhonemizeFn = (text: string, language?: string) => Promise<string[]>

let loading: Promise<PhonemizeFn> | null = null

export function phonemize(text: string, language?: string): Promise<string[]> {
  loading ??= import(/* @vite-ignore */ `${MODELS_URL}${PHONEMIZER_PATH}`).then(
    (module: { phonemize: PhonemizeFn }) => module.phonemize
  )
  return loading.then((fn) => fn(text, language))
}
