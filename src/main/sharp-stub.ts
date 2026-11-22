/*
 * transformers.js imports sharp for image work and refuses to load without it. The voice worker
 * only handles audio, so the import resolves to this stand-in instead of sharp's native binaries,
 * which Kificut does not ship. Calling it is a bug.
 */
export default function sharp(): never {
  throw new Error('The voice engine does not process images.')
}
