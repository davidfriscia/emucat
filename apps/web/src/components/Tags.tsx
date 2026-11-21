import {
  formatTag,
  normalizedTagKey,
  normalizeTagInput,
  TAGS_PER_ENTITY_MAX,
  type Tag,
} from '@emucat/contracts';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { GroupBase, StylesConfig } from 'react-select';
import CreatableSelect from 'react-select/creatable';
import { createTag, searchTags, setTags, type TagTarget } from '../api';
import { InfoDialog } from './Dialogs';
import { describeError } from './States';

export { TagList } from './TagList';

interface TagOption {
  value: string;
  label: string;
}

const toOption = (tag: Tag): TagOption => ({ value: tag.id, label: tag.name });
const fromOption = (option: TagOption): Tag => ({ id: option.value, name: option.label });

const SEARCH_DELAY_MS = 200;

/**
 * Bootstrap's own variables, so that the selector follows the light and dark themes like every other control.
 */
const styles: StylesConfig<TagOption, true, GroupBase<TagOption>> = {
  control: (base, state) => ({
    ...base,
    backgroundColor: 'var(--bs-body-bg)',
    borderColor: state.isFocused ? 'var(--bs-primary)' : 'var(--bs-border-color)',
    boxShadow: state.isFocused ? '0 0 0 0.25rem rgba(var(--bs-primary-rgb), 0.25)' : 'none',
    '&:hover': { borderColor: state.isFocused ? 'var(--bs-primary)' : 'var(--bs-border-color)' },
    opacity: state.isDisabled ? 0.65 : 1,
  }),
  input: (base) => ({ ...base, color: 'var(--bs-body-color)' }),
  placeholder: (base) => ({ ...base, color: 'var(--bs-secondary-color)' }),
  menu: (base) => ({
    ...base,
    backgroundColor: 'var(--bs-body-bg)',
    border: '1px solid var(--bs-border-color)',
    zIndex: 1060,
  }),
  option: (base, state) => ({
    ...base,
    color: 'var(--bs-body-color)',
    backgroundColor: state.isFocused ? 'var(--bs-tertiary-bg)' : 'transparent',
    '&:active': { backgroundColor: 'var(--bs-secondary-bg)' },
  }),
  multiValue: (base) => ({
    ...base,
    backgroundColor: 'var(--emucat-tag-bg)',
    border: '1px solid var(--emucat-tag-border)',
    borderRadius: '999px',
  }),
  multiValueLabel: (base) => ({ ...base, color: 'var(--emucat-tag-text)' }),
  multiValueRemove: (base) => ({
    ...base,
    color: 'var(--emucat-tag-text)',
    borderRadius: '999px',
    '&:hover': {
      backgroundColor: 'var(--bs-danger-bg-subtle)',
      color: 'var(--bs-danger-text-emphasis)',
    },
  }),
  noOptionsMessage: (base) => ({ ...base, color: 'var(--bs-secondary-color)' }),
  loadingMessage: (base) => ({ ...base, color: 'var(--bs-secondary-color)' }),
  indicatorSeparator: (base) => ({ ...base, backgroundColor: 'var(--bs-border-color)' }),
  dropdownIndicator: (base) => ({ ...base, color: 'var(--bs-secondary-color)' }),
  clearIndicator: (base) => ({ ...base, color: 'var(--bs-secondary-color)' }),
};

/**
 * Chooses the tags of one VM, version or screenshot: searches the central catalog, selects existing tags, and
 * creates one when nothing matches (`Create #windows-98`). Every change is saved at once, and what is shown is
 * always what the server confirmed: a failed save leaves the previous tags, and says why. The same component
 * serves every kind of target.
 */
export function TagSelector({
  target,
  value,
  onChange,
  label,
  description,
}: {
  target: TagTarget;
  value: readonly Tag[];
  /** Called with what the server now holds, after each successful save. */
  onChange: (tags: Tag[]) => void;
  label: string;
  description?: string;
}) {
  const id = useId();
  const [input, setInput] = useState('');
  const [options, setOptions] = useState<TagOption[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchFailed, setSearchFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const saving$ = useRef(false);
  const selected = useMemo(() => value.map(toOption), [value]);

  // Searches the catalog as the person types, after a short pause, and only while the menu is open.
  useEffect(() => {
    if (!menuOpen) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setSearching(true);
      setSearchFailed(false);
      searchTags(input, controller.signal).then(
        (tags) => {
          setOptions(tags.map(toOption));
          setSearching(false);
        },
        () => {
          if (controller.signal.aborted) return;
          setSearchFailed(true);
          setSearching(false);
        },
      );
    }, SEARCH_DELAY_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
      setSearching(false);
    };
  }, [input, menuOpen]);

  const save = async (work: () => Promise<Tag[]>) => {
    // One save at a time: a second change waits for the first to be confirmed.
    if (saving$.current) return;
    saving$.current = true;
    setSaving(true);
    setError(null);
    try {
      onChange(await work());
    } catch (failure) {
      setError(failure);
    } finally {
      saving$.current = false;
      setSaving(false);
    }
  };

  const assign = (tags: readonly Tag[]) =>
    save(() => setTags(target, [...new Set(tags.map((tag) => tag.id))]));

  const create = (raw: string) =>
    save(async () => {
      const { tag } = await createTag(raw);
      // An existing tag with the same name comes back instead of a new one: never a duplicate.
      const ids = [...new Set([...value.map((item) => item.id), tag.id])];
      return setTags(target, ids);
    });

  const validation = input.trim() === '' ? null : normalizeTagInput(input);
  const full = value.length >= TAGS_PER_ENTITY_MAX;

  const isValidNewOption = (
    raw: string,
    current: readonly TagOption[],
    available: readonly (TagOption | GroupBase<TagOption>)[],
  ) => {
    const result = normalizeTagInput(raw);
    if (!result.ok || full) return false;
    const taken = (option: TagOption | GroupBase<TagOption>) =>
      'label' in option && normalizedTagKey(option.label ?? '') === result.normalizedName;
    return !current.some(taken) && !available.some(taken);
  };

  const noOptionsMessage = () => {
    if (searchFailed) return 'The tags could not be loaded';
    if (full) return `At most ${TAGS_PER_ENTITY_MAX} tags`;
    if (validation && !validation.ok) return validation.message;
    const assigned = validation?.ok
      ? value.find((tag) => normalizedTagKey(tag.name) === validation.normalizedName)
      : undefined;
    if (assigned) return `${formatTag(assigned.name)} is already assigned`;
    return input.trim() === '' ? 'Type to find or create a tag' : 'No matching tags';
  };

  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  return (
    <div className="tag-selector">
      <label htmlFor={`${id}-input`} className="form-label">
        {label}
      </label>
      <CreatableSelect<TagOption, true>
        inputId={`${id}-input`}
        instanceId={id}
        isMulti
        isClearable={false}
        classNamePrefix="tag-select"
        styles={styles}
        value={selected}
        options={options}
        // The server has already filtered: show what it found, in its order.
        filterOption={null}
        inputValue={input}
        onInputChange={(next, meta) => {
          if (meta.action === 'input-change') setInput(next);
          if (meta.action === 'set-value' || meta.action === 'menu-close') setInput('');
        }}
        onMenuOpen={() => setMenuOpen(true)}
        onMenuClose={() => setMenuOpen(false)}
        // Not disabled while saving, which would take the focus away: changes wait for the save instead.
        isLoading={searching || saving}
        placeholder={value.length === 0 ? 'Add tags…' : 'Add another tag…'}
        // The create option's label is already `Create #name`; every other option is a tag, shown with its #.
        formatOptionLabel={(option) =>
          '__isNew__' in option ? option.label : formatTag(option.label)
        }
        formatCreateLabel={(raw) => {
          const result = normalizeTagInput(raw);
          return `Create ${formatTag(result.ok ? result.name : raw)}`;
        }}
        isValidNewOption={isValidNewOption}
        isOptionDisabled={() => full}
        noOptionsMessage={noOptionsMessage}
        loadingMessage={() => (saving ? 'Saving…' : 'Searching…')}
        onCreateOption={(raw) => void create(raw)}
        onChange={(next, meta) => {
          if (meta.action === 'create-option') return;
          void assign(next.map(fromOption));
        }}
        aria-describedby={
          [description ? helpId : null, error ? errorId : null].filter(Boolean).join(' ') ||
          undefined
        }
        aria-invalid={error ? true : undefined}
        ariaLiveMessages={{
          onChange: ({ action, label: changed }) =>
            action === 'remove-value' || action === 'pop-value'
              ? `${formatTag(changed)} removed`
              : `${formatTag(changed)} selected`,
        }}
      />
      {description ? (
        <div id={helpId} className="form-text">
          {description}
        </div>
      ) : null}
      {saving ? (
        <div className="form-text" role="status">
          Saving tags…
        </div>
      ) : null}
      {error ? (
        <div id={errorId} className="invalid-feedback d-block" role="alert">
          The tags were not saved: {describeError(error)}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The tags of one screenshot or version, edited in a small dialog so that cards and version rows stay compact.
 * Each change is saved as it is made, so the dialog only needs to be closed.
 */
export function TagEditorDialog({
  title,
  subject,
  target,
  value,
  onChange,
  onClose,
}: {
  title: string;
  /** What is being tagged, as the person knows it. */
  subject: string;
  target: TagTarget;
  value: readonly Tag[];
  onChange: (tags: Tag[]) => void;
  onClose: () => void;
}) {
  return (
    <InfoDialog title={title} onClose={onClose}>
      <p className="small mb-3">
        <span className="media-filename">{subject}</span>
      </p>
      <TagSelector
        target={target}
        value={value}
        onChange={onChange}
        label="Tags"
        description="Saved as you change them. These tags belong to this item only: nothing is copied to or from its VM."
      />
    </InfoDialog>
  );
}
