import { adminVmRoute, vmPathParamsSchema, type VmIdentity } from '@emucat/contracts';
import { HardDrive, History, Images, NotebookPen, Settings, type LucideIcon } from 'lucide-react';
import { matchPath, useParams } from 'react-router';

/**
 * Every navigation menu of the application, in one place (docs/architecture.md, "Navigation").
 *
 * Two levels: the header's global areas, and the contextual sidebar of the area that is open. The menus only say
 * where to go. Who may go there is decided by the route guards and, in the end, by the API: hiding an entry is
 * never what keeps anyone out.
 */
export interface NavItem {
  /** The visible label, which is also the accessible name of the link. */
  label: string;
  to: string;
  /** Active only on exactly this path, not on the paths below it. */
  end?: boolean;
  /** Drawn before the label, never instead of it. */
  icon?: LucideIcon;
}

/** The header's global areas. */
export type GlobalArea = 'catalog' | 'admin';

export const CATALOG_PATH = '/';
export const ADMIN_PATH = '/admin';

/**
 * Which global area a path belongs to. A VM's management pages are under /admin, but they are reached from the
 * catalog, and only from there, so they belong to Catalog.
 */
export function globalAreaOf(pathname: string): GlobalArea | null {
  if (matchPath({ path: '/admin/vms/*', end: false }, pathname)) return 'catalog';
  if (matchPath({ path: ADMIN_PATH, end: false }, pathname)) return 'admin';
  if (pathname === '/' || matchPath({ path: '/vms/*', end: false }, pathname)) return 'catalog';
  return null;
}

/** The Admin area's sidebar: exactly these destinations, in this order. */
export const ADMIN_NAV_ITEMS: readonly NavItem[] = [
  { label: 'Agents', to: '/admin/agents' },
  { label: 'Registrations', to: '/admin/registrations' },
  { label: 'Repositories', to: '/admin/repositories' },
  { label: 'Appearance', to: '/admin/appearance' },
  { label: 'Application Updates', to: '/admin/updates' },
];

/** Where /admin itself leads: the first destination of its sidebar. */
export const ADMIN_HOME = ADMIN_NAV_ITEMS[0]?.to ?? '/admin/agents';

/** The sections of a VM's management, as path segments under {@link adminVmRoute}. '' is General. */
export const VM_SECTIONS = {
  general: '',
  versions: 'versions',
  copies: 'copies',
  notes: 'notes',
  screenshots: 'screenshots',
} as const;
export type VmSection = keyof typeof VM_SECTIONS;

/** The address of one section of a VM's management. */
export function vmSectionRoute(vm: VmIdentity, section: VmSection): string {
  const segment = VM_SECTIONS[section];
  return segment ? `${adminVmRoute(vm)}/${segment}` : adminVmRoute(vm);
}

/** A VM's management sidebar: exactly these destinations, in this order. */
export function vmManageNavItems(vm: VmIdentity): NavItem[] {
  return [
    { label: 'General', to: vmSectionRoute(vm, 'general'), end: true, icon: Settings },
    { label: 'Version History', to: vmSectionRoute(vm, 'versions'), icon: History },
    { label: 'Local copies and restore', to: vmSectionRoute(vm, 'copies'), icon: HardDrive },
    { label: 'Notes', to: vmSectionRoute(vm, 'notes'), icon: NotebookPen },
    { label: 'Screenshots', to: vmSectionRoute(vm, 'screenshots'), icon: Images },
  ];
}

/**
 * The VM a route names, or `null` when its address does not name a valid one. Only the VM's own parameters are read:
 * the router may hold others, such as the application's root splat.
 */
export function useVmRouteIdentity(): VmIdentity | null {
  const { emulatorType, vmName } = useParams();
  const parsed = vmPathParamsSchema.safeParse({ emulatorType, vmName });
  return parsed.success ? parsed.data : null;
}
