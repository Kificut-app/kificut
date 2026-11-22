import { useEffect, useRef, useState } from 'react'

/*
 * A floating picture of the camera while recording, mirrored like a mirror. Round over a screen
 * recording, wide when only the camera is recorded. Drag it anywhere.
 */

export function CameraBubble() {
  const video = useRef<HTMLVideoElement>(null)
  const [shape, setShape] = useState<'circle' | 'wide'>('circle')
  const [error, setError] = useState(false)

  useEffect(() => {
    let stream: MediaStream | null = null
    let stopped = false
    void (async () => {
      try {
        const view = await window.kificut.recorder.cameraView()
        setShape(view.shape)
        stream = await navigator.mediaDevices.getUserMedia({
          video: { deviceId: { exact: view.deviceId }, width: { ideal: 640 }, height: { ideal: 360 } }
        })
        if (stopped) stream.getTracks().forEach((t) => t.stop())
        else if (video.current) video.current.srcObject = stream
      } catch {
        setError(true)
      }
    })()
    return () => {
      stopped = true
      stream?.getTracks().forEach((t) => t.stop())
    }
  }, [])

  return (
    <div className={`rec-camera rec-camera--${shape}`}>
      {error ? (
        <span className="rec-camera__error">No camera picture</span>
      ) : (
        <video ref={video} autoPlay muted playsInline />
      )}
    </div>
  )
}
