import { formatTag, type Tag } from '@emucat/contracts';

/**
 * Tags as compact chips, always with their `#`. Plain text, never markup. Nothing at all when there are none,
 * so that an untagged item adds no clutter.
 */
export function TagList({
  tags,
  label = 'Tags',
  className = '',
}: {
  tags: readonly Tag[];
  label?: string;
  className?: string;
}) {
  if (tags.length === 0) return null;
  return (
    <ul className={`tag-list ${className}`.trim()} aria-label={label}>
      {tags.map((tag) => (
        <li key={tag.id} className="tag-chip">
          {formatTag(tag.name)}
        </li>
      ))}
    </ul>
  );
}
