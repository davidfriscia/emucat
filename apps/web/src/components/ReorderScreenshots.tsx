import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  adminMediaPath,
  type AdminMedia,
  type AdminMediaListResponse,
  type VmIdentity,
} from '@emucat/contracts';
import { useMemo, useRef, useState } from 'react';
import { ApiRequestError, reorderMedia } from '../api';
import { VmImage } from './Catalog';
import { useModalDialog } from './Gallery';
import { FormError } from './States';

/** Moves one item from one position to another. Exported for tests; positions are zero-based. */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) {
    return [...items];
  }
  return arrayMove([...items], from, to);
}

function SortableRow({
  vm,
  item,
  position,
  count,
  disabled,
  onMove,
}: {
  vm: VmIdentity;
  item: AdminMedia;
  position: number;
  count: number;
  disabled: boolean;
  onMove: (from: number, to: number) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.id, disabled });
  const style = {
    transform: CSS.Translate.toString(transform),
    transition,
  };
  return (
    <tr
      ref={setNodeRef}
      style={style}
      className={isDragging ? 'reorder-row reorder-row-dragging' : 'reorder-row'}
      data-media-id={item.id}
    >
      <td className="reorder-handle-cell">
        <button
          ref={setActivatorNodeRef}
          type="button"
          className="btn btn-sm btn-outline-secondary theme-button reorder-handle"
          aria-label={`Drag ${item.originalFilename}, at position ${position + 1} of ${count}`}
          disabled={disabled}
          {...attributes}
          {...listeners}
        >
          <span aria-hidden="true">⠿</span>
        </button>
      </td>
      <td className="reorder-position" aria-label="Position">
        {position + 1}
      </td>
      <td className="reorder-thumbnail">
        <VmImage src={adminMediaPath(vm, item.id, 'thumbnail')} alt="" />
      </td>
      <td className="reorder-name">
        <span className="media-filename">{item.originalFilename}</span>
        {item.isMain ? <span className="badge text-bg-primary ms-2">Main image</span> : null}
        <div className="small text-body-secondary">
          {item.widthPx} × {item.heightPx}
        </div>
      </td>
      <td className="reorder-moves text-end">
        <div
          className="btn-group btn-group-sm"
          role="group"
          aria-label={`Move ${item.originalFilename}`}
        >
          <button
            type="button"
            className="btn btn-outline-secondary theme-button"
            disabled={disabled || position === 0}
            aria-label={`Move ${item.originalFilename} up`}
            onClick={() => onMove(position, position - 1)}
          >
            ↑
          </button>
          <button
            type="button"
            className="btn btn-outline-secondary theme-button"
            disabled={disabled || position === count - 1}
            aria-label={`Move ${item.originalFilename} down`}
            onClick={() => onMove(position, position + 1)}
          >
            ↓
          </button>
        </div>
      </td>
    </tr>
  );
}

/**
 * Arranges a VM's screenshots by dragging rows by their handles, with the keyboard (focus a handle, Space,
 * the arrow keys, Space), or with the move buttons. Nothing is sent while arranging: Save Order sends the whole
 * order once, and Cancel discards it. The main image is independent of the order and is never changed here.
 */
export function ReorderScreenshotsDialog({
  vm,
  media,
  onSaved,
  onClose,
}: {
  vm: VmIdentity;
  media: readonly AdminMedia[];
  onSaved: (next: AdminMediaListResponse) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const [order, setOrder] = useState<AdminMedia[]>(() => [...media]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useModalDialog(dialog, heading, () => {
    if (!saving) onClose();
  });
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const ids = useMemo(() => order.map((item) => item.id), [order]);
  const changed = ids.some((id, index) => id !== media[index]?.id);
  const nameOf = (id: unknown) =>
    order.find((item) => item.id === id)?.originalFilename ?? 'The screenshot';
  const positionOf = (id: unknown) => ids.indexOf(String(id)) + 1;

  const announcements: Announcements = {
    onDragStart: ({ active }) =>
      `Picked up ${nameOf(active.id)}, at position ${positionOf(active.id)} of ${ids.length}.`,
    onDragOver: ({ active, over }) =>
      over
        ? `${nameOf(active.id)} is over position ${positionOf(over.id)} of ${ids.length}.`
        : `${nameOf(active.id)} is not over a position.`,
    onDragEnd: ({ active, over }) =>
      over
        ? `${nameOf(active.id)} was dropped at position ${positionOf(over.id)} of ${ids.length}.`
        : `${nameOf(active.id)} was dropped where it was.`,
    onDragCancel: ({ active }) => `Moving ${nameOf(active.id)} was cancelled.`,
  };

  const move = (from: number, to: number) => setOrder((current) => moveItem(current, from, to));

  const dragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    move(ids.indexOf(String(active.id)), ids.indexOf(String(over.id)));
  };

  const save = async () => {
    if (saving || !changed) return;
    setSaving(true);
    setError(null);
    try {
      onSaved(await reorderMedia(vm, ids));
      onClose();
    } catch (failure) {
      setError(failure);
      setSaving(false);
    }
  };

  const conflict = error instanceof ApiRequestError && error.status === 409;
  return (
    <div className="modal-backdrop-custom">
      <div
        ref={dialog}
        className="card restore-dialog reorder-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="reorder-dialog-title"
        aria-describedby="reorder-dialog-help"
      >
        <div className="card-body d-flex flex-column">
          <div className="d-flex flex-wrap align-items-center gap-2 mb-2">
            <h2
              id="reorder-dialog-title"
              ref={heading}
              tabIndex={-1}
              className="h5 card-title mb-0"
            >
              Reorder screenshots
            </h2>
            {changed ? (
              <span className="badge text-bg-warning" role="status">
                Unsaved changes
              </span>
            ) : null}
          </div>
          <p id="reorder-dialog-help" className="small text-body-secondary">
            Drag a row by its handle, or focus a handle and press Space, then the arrow keys, then
            Space again. Every gallery shows this order once it is saved. The main image stays the
            main image.
          </p>
          <FormError error={error} />
          {conflict ? (
            <p className="small">
              Close this dialog to see the current screenshots, then reorder them again.
            </p>
          ) : null}
          {order.length === 0 ? (
            <p className="text-body-secondary">There are no screenshots to reorder.</p>
          ) : (
            <div className="reorder-scroll mb-3">
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={dragEnd}
                accessibility={{ announcements }}
              >
                <SortableContext items={ids} strategy={verticalListSortingStrategy}>
                  <table className="table table-sm align-middle mb-0 reorder-table">
                    <thead>
                      <tr>
                        <th scope="col">
                          <span className="visually-hidden">Drag handle</span>
                        </th>
                        <th scope="col">#</th>
                        <th scope="col">
                          <span className="visually-hidden">Thumbnail</span>
                        </th>
                        <th scope="col">Screenshot</th>
                        <th scope="col" className="text-end">
                          Move
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {order.map((item, index) => (
                        <SortableRow
                          key={item.id}
                          vm={vm}
                          item={item}
                          position={index}
                          count={order.length}
                          disabled={saving}
                          onMove={move}
                        />
                      ))}
                    </tbody>
                  </table>
                </SortableContext>
              </DndContext>
            </div>
          )}
          <div className="d-flex flex-wrap gap-2">
            <button
              type="button"
              className="btn btn-primary"
              disabled={saving || !changed}
              onClick={() => void save()}
            >
              {saving ? 'Saving…' : 'Save Order'}
            </button>
            <button
              type="button"
              className="btn btn-outline-secondary theme-button"
              disabled={saving}
              onClick={onClose}
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
