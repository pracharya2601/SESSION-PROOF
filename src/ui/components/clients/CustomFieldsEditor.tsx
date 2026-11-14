import { AnimatePresence, Reorder, useDragControls, useReducedMotion } from "framer-motion";
import { ArrowDown, ArrowUp, GripVertical, ListPlus, Plus, Trash2 } from "lucide-react";
import { Button, EmptyState, Input } from "../../design";
import { Section, type Patch } from "./ClientForm";
import { type ClientDraft, type DraftErrors, LIMITS, MAX_CUSTOM_FIELDS, newUid } from "./shared";

type Row = ClientDraft["customFields"][number];

export function CustomFieldsEditor({ draft, patch, errors }: { draft: ClientDraft; patch: Patch; errors: DraftErrors }) {
  const rows = draft.customFields;
  const set = (customFields: Row[]) => patch({ customFields });
  const full = rows.length >= MAX_CUSTOM_FIELDS;

  function add() {
    if (full) return;
    const uid = newUid();
    set([...rows, { uid, label: "", value: "" }]);
    window.setTimeout(() => document.getElementById(`cf-label-${uid}`)?.focus(), 30);
  }
  function move(i: number, d: -1 | 1) {
    const j = i + d;
    if (j < 0 || j >= rows.length) return;
    const next = rows.slice();
    [next[i], next[j]] = [next[j]!, next[i]!];
    set(next);
    const uid = rows[i]!.uid;
    window.setTimeout(() => document.getElementById(`cf-${d < 0 ? "up" : "down"}-${uid}`)?.focus(), 0);
  }

  return (
    <Section
      icon={<ListPlus size={18} aria-hidden="true" />}
      title="Custom fields"
      subtitle={`Extra label/value lines printed on this client's invoice (when the template's Custom fields section is on). ${rows.length}/${MAX_CUSTOM_FIELDS}`}
    >
      {rows.length === 0 ? (
        <EmptyState
          compact
          icon={<ListPlus size={22} />}
          title="No custom fields"
          description="Add things like a member ID, service plan code or program name."
          action={
            <Button size="sm" icon={<Plus size={14} />} onClick={add}>
              Add field
            </Button>
          }
        />
      ) : (
        <>
          <Reorder.Group axis="y" values={rows} onReorder={set} className="cl-cf-list" as="ul">
            <AnimatePresence initial={false}>
              {rows.map((r, i) => (
                <CfRow
                  key={r.uid}
                  row={r}
                  index={i}
                  count={rows.length}
                  onChange={(p) => set(rows.map((x) => (x.uid === r.uid ? { ...x, ...p } : x)))}
                  onRemove={() => set(rows.filter((x) => x.uid !== r.uid))}
                  onMove={(d) => move(i, d)}
                />
              ))}
            </AnimatePresence>
          </Reorder.Group>
          {errors.customFields && (
            <p className="ds-field-err cl-cf-error" role="alert">
              {errors.customFields}
            </p>
          )}
          <div>
            <Button size="sm" icon={<Plus size={14} />} onClick={add} disabled={full}>
              {full ? `Maximum ${MAX_CUSTOM_FIELDS} fields` : "Add field"}
            </Button>
          </div>
        </>
      )}
    </Section>
  );
}

function CfRow({
  row,
  index,
  count,
  onChange,
  onRemove,
  onMove,
}: {
  row: Row;
  index: number;
  count: number;
  onChange: (p: Partial<Row>) => void;
  onRemove: () => void;
  onMove: (d: -1 | 1) => void;
}) {
  const controls = useDragControls();
  const reduce = useReducedMotion();
  const labelMissing = row.label.trim() === "" && row.value.trim() !== "";
  return (
    <Reorder.Item
      value={row}
      as="li"
      className="cl-cf-row"
      dragListener={false}
      dragControls={controls}
      initial={reduce ? { opacity: 0 } : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reduce ? { opacity: 0 } : { opacity: 0, x: -16, height: 0, marginTop: 0, paddingTop: 0, paddingBottom: 0 }}
    >
      <button
        type="button"
        className="cl-cf-grip"
        aria-hidden="true"
        tabIndex={-1}
        onPointerDown={(e) => {
          e.preventDefault();
          controls.start(e);
        }}
      >
        <GripVertical size={16} />
      </button>
      <Input
        id={`cf-label-${row.uid}`}
        aria-label={`Field ${index + 1} label`}
        placeholder="Label"
        value={row.label}
        maxLength={LIMITS.fieldLabel + 10}
        invalid={labelMissing || row.label.trim().length > LIMITS.fieldLabel}
        onChange={(e) => onChange({ label: e.target.value })}
        className="cl-cf-label"
      />
      <Input
        aria-label={`Field ${index + 1} value`}
        placeholder="Value"
        value={row.value}
        maxLength={LIMITS.fieldValue + 10}
        invalid={row.value.trim().length > LIMITS.fieldValue}
        onChange={(e) => onChange({ value: e.target.value })}
        className="cl-cf-value"
      />
      <div className="cl-cf-actions">
        <Button
          id={`cf-up-${row.uid}`}
          variant="ghost"
          size="sm"
          iconOnly
          aria-label={`Move field ${index + 1} up`}
          icon={<ArrowUp size={14} />}
          disabled={index === 0}
          onClick={() => onMove(-1)}
        />
        <Button
          id={`cf-down-${row.uid}`}
          variant="ghost"
          size="sm"
          iconOnly
          aria-label={`Move field ${index + 1} down`}
          icon={<ArrowDown size={14} />}
          disabled={index === count - 1}
          onClick={() => onMove(1)}
        />
        <Button variant="ghost" size="sm" iconOnly aria-label={`Remove field ${index + 1}`} icon={<Trash2 size={14} />} onClick={onRemove} />
      </div>
    </Reorder.Item>
  );
}
