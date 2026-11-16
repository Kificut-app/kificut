import {
  Bookmark,
  Magnet,
  Maximize2,
  MousePointer2,
  Plus,
  Scissors,
  SquareSplitHorizontal,
  Trash2,
  ZoomIn,
  ZoomOut
} from 'lucide-react'
import { useEditor } from '../../store/editor'
import {
  addMarker,
  addTrack,
  deleteSelection,
  setZoom,
  splitAtPlayhead,
  zoomBy,
  zoomToFit
} from '../../store/actions'
import { openMenu } from '../../store/ui'
import { MAX_ZOOM, MIN_ZOOM } from '../../lib/timeline-view'
import { deleteKey, shiftKey } from '../../lib/platform'
import { Button, IconButton, Segmented } from '../ui/controls'

const SLIDER_STEPS = 1000

function zoomToSlider(zoom: number, max: number): number {
  return (Math.log(zoom / MIN_ZOOM) / Math.log(max / MIN_ZOOM)) * SLIDER_STEPS
}

function sliderToZoom(value: number, max: number): number {
  return MIN_ZOOM * Math.pow(max / MIN_ZOOM, value / SLIDER_STEPS)
}

export function TimelineToolbar() {
  const tool = useEditor((s) => s.tool)
  const snapping = useEditor((s) => s.snapping)
  const zoom = useEditor((s) => s.zoom)
  const hasSelection = useEditor((s) => s.selection.length > 0)
  const fps = useEditor((s) => s.project!.settings.fps)
  const maxZoom = Math.min(MAX_ZOOM, fps * 40)

  return (
    <div className="timeline-toolbar">
      <div className="timeline-toolbar__group">
        <Segmented
          value={tool}
          onChange={(value) => useEditor.setState({ tool: value })}
          options={[
            { value: 'select', icon: <MousePointer2 size={14} />, tip: 'Selection tool|V' },
            { value: 'razor', icon: <Scissors size={14} />, tip: 'Razor tool|C' }
          ]}
        />
        <span className="toolbar-divider" />
        <IconButton tip="Split at playhead|S" onClick={splitAtPlayhead}>
          <SquareSplitHorizontal size={16} />
        </IconButton>
        <IconButton
          tip={`Delete|${deleteKey}`}
          disabled={!hasSelection}
          onClick={() => deleteSelection(false)}
        >
          <Trash2 size={16} />
        </IconButton>
        <IconButton tip="Add marker|M" onClick={addMarker}>
          <Bookmark size={16} />
        </IconButton>
        <IconButton
          tip="Snapping|N"
          active={snapping}
          onClick={() => useEditor.setState({ snapping: !snapping })}
        >
          <Magnet size={16} />
        </IconButton>
        <span className="toolbar-divider" />
        <Button
          variant="ghost"
          size="sm"
          icon={<Plus size={14} />}
          onClick={(e) =>
            openMenu(e, [
              { label: 'Add Video Track', run: () => addTrack('video') },
              { label: 'Add Audio Track', run: () => addTrack('audio') }
            ])
          }
        >
          Track
        </Button>
      </div>

      <div className="timeline-toolbar__group">
        <IconButton tip="Zoom out|-" onClick={() => zoomBy(1 / 1.5)}>
          <ZoomOut size={16} />
        </IconButton>
        <input
          type="range"
          className="slider slider--zoom"
          aria-label="Timeline zoom"
          min={0}
          max={SLIDER_STEPS}
          value={zoomToSlider(zoom, maxZoom)}
          style={
            { '--fill': `${(zoomToSlider(zoom, maxZoom) / SLIDER_STEPS) * 100}%` } as React.CSSProperties
          }
          onChange={(e) => setZoom(sliderToZoom(parseFloat(e.target.value), maxZoom))}
          onKeyDown={(e) => e.stopPropagation()}
        />
        <IconButton tip="Zoom in|=" onClick={() => zoomBy(1.5)}>
          <ZoomIn size={16} />
        </IconButton>
        <IconButton tip={`Zoom to fit|${shiftKey}Z`} onClick={zoomToFit}>
          <Maximize2 size={15} />
        </IconButton>
      </div>
    </div>
  )
}
