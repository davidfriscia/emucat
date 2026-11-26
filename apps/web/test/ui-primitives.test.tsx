import { fireEvent, render, screen, within } from '@testing-library/react';
import { Info, ShieldCheck, Trash2 } from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';
import {
  IconButton,
  IconToggleButton,
  Toolbar,
  ToolbarGroup,
  ToolbarSeparator,
} from '../src/components/ui/IconButton';
import { InfoPopover } from '../src/components/ui/Popover';
import { StatusChip } from '../src/components/ui/StatusChip';
import { ADMIN_NAV_ITEMS, vmManageNavItems } from '../src/navigation';

/** The shared icon-based primitives (decisions 0058 and 0059), on their own. */

describe('IconButton', () => {
  it('is named by its label, with the tooltip only repeating it for the eye', () => {
    render(<IconButton icon={Trash2} label="Delete Master" tooltip="Delete snapshot" />);
    const button = screen.getByRole('button', { name: 'Delete Master' });
    const tooltip = button.querySelector('.icon-tooltip') as HTMLElement;
    expect(tooltip.textContent).toBe('Delete snapshot');
    expect(tooltip.getAttribute('aria-hidden')).toBe('true');
    expect(button.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('stays natively disabled when no reason is given', () => {
    const onClick = vi.fn();
    render(<IconButton icon={Trash2} label="Delete" disabled onClick={onClick} />);
    const button = screen.getByRole('button', { name: 'Delete' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-disabled')).toBeNull();
  });

  it('explains a disabled action: focusable, described by its reason, and inert', () => {
    const onClick = vi.fn();
    const onOuter = vi.fn();
    render(
      <div onClick={onOuter}>
        <IconButton
          icon={Trash2}
          label="Delete A"
          tooltip="Delete snapshot"
          disabled
          disabledReason="No online agent can reach this snapshot’s repository."
          onClick={onClick}
        />
      </div>,
    );
    const button = screen.getByRole('button', { name: 'Delete A' }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    const described = document.getElementById(button.getAttribute('aria-describedby') ?? '');
    expect(described?.textContent).toBe('No online agent can reach this snapshot’s repository.');
    expect((button.querySelector('.icon-tooltip-title') as HTMLElement).textContent).toBe(
      'Delete snapshot unavailable',
    );
    button.focus();
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);
    fireEvent.keyDown(button, { key: 'Enter' });
    expect(onClick).not.toHaveBeenCalled();
    expect(onOuter).not.toHaveBeenCalled();
  });

  it('acts, and has no description, once it is enabled again', () => {
    const onClick = vi.fn();
    render(
      <IconButton
        icon={Trash2}
        label="Delete A"
        disabled={false}
        disabledReason="Not now."
        onClick={onClick}
      />,
    );
    const button = screen.getByRole('button', { name: 'Delete A' });
    expect(button.getAttribute('aria-disabled')).toBeNull();
    expect(button.getAttribute('aria-describedby')).toBeNull();
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('says when it is busy', () => {
    render(<IconButton icon={Trash2} label="Delete" loading />);
    const button = screen.getByRole('button', { name: 'Delete' });
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.querySelector('.icon-spin')).toBeTruthy();
  });

  it('keeps a disabled toggle from toggling', () => {
    const onPressedChange = vi.fn();
    render(
      <IconToggleButton
        icon={Info}
        label="Details"
        pressed={false}
        disabled
        disabledReason="Nothing to show."
        onPressedChange={onPressedChange}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(onPressedChange).not.toHaveBeenCalled();
  });

  it('marks a destructive action for its hover and focus styling only', () => {
    render(<IconButton icon={Trash2} label="Delete" danger />);
    expect(screen.getByRole('button', { name: 'Delete' }).className).toContain(
      'icon-button-danger',
    );
  });
});

describe('Toolbar', () => {
  it('names its groups, and crosses them with the arrow keys, reaching an explained disabled action', () => {
    render(
      <Toolbar label="Actions for A">
        <ToolbarGroup label="Run and restore">
          <IconButton icon={Info} label="One" />
        </ToolbarGroup>
        <ToolbarSeparator />
        <ToolbarGroup label="Lifecycle">
          <IconButton icon={Trash2} label="Two" disabled disabledReason="Not now." />
          <IconButton icon={Trash2} label="Three" disabled />
        </ToolbarGroup>
      </Toolbar>,
    );
    const toolbar = screen.getByRole('toolbar', { name: 'Actions for A' });
    expect(within(toolbar).getByRole('group', { name: 'Lifecycle' })).toBeTruthy();
    expect(within(toolbar).getByRole('separator').getAttribute('aria-orientation')).toBe(
      'vertical',
    );
    const one = screen.getByRole('button', { name: 'One' });
    one.focus();
    fireEvent.keyDown(one, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Two' }));
    // A natively disabled button without a reason is skipped.
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'End' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Two' }));
  });
});

describe('InfoPopover', () => {
  it('opens a named panel, closes on Escape and gives the focus back', () => {
    render(
      <InfoPopover icon={Info} label="Information about A" tooltip="Version information" title="A">
        <p>Details of A</p>
      </InfoPopover>,
    );
    const button = screen.getByRole('button', { name: 'Information about A' });
    expect(button.querySelector('.icon-tooltip')?.textContent).toBe('Version information');
    fireEvent.click(button);
    const panel = screen.getByRole('dialog', { name: 'A' });
    expect(within(panel).getByText('Details of A')).toBeTruthy();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(panel, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(button);
  });
});

describe('StatusChip', () => {
  it('shows a few words, and gives the whole statement once, to everyone', () => {
    render(
      <StatusChip
        icon={ShieldCheck}
        tone="success"
        label="Verified when published"
        detail="Verified by the agent when published: 7 files, 677.0 MiB"
      />,
    );
    expect(screen.getAllByText(/Verified by the agent when published/)).toHaveLength(1);
    const chip = screen.getByText('Verified when published').closest('.status-chip');
    expect(chip?.className).toContain('status-chip-success');
    expect(chip?.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('needs no tooltip when the label says it all', () => {
    render(<StatusChip icon={ShieldCheck} label="2 branches" />);
    expect(
      screen.getByText('2 branches').closest('.status-chip')?.querySelector('.icon-tooltip'),
    ).toBeNull();
  });
});

describe('navigation icons', () => {
  it('gives every VM section an icon, and leaves the Admin sidebar as it was', () => {
    const items = vmManageNavItems({ emulatorType: 'qemu', vmName: 'Win98' });
    expect(items.map((item) => item.label)).toEqual([
      'General',
      'Version History',
      'Local copies and restore',
      'Notes',
      'Screenshots',
    ]);
    expect(items.every((item) => item.icon !== undefined)).toBe(true);
    expect(ADMIN_NAV_ITEMS.some((item) => item.icon !== undefined)).toBe(false);
  });
});
