import { validateVmName } from './vm-name.js';

export interface SnapshotTimestamp {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

export interface ParsedSnapshotName {
  vmName: string;
  timestamp: SnapshotTimestamp;
}

const SNAPSHOT_NAME = /^(.+)_([0-9]{4})([0-9]{2})([0-9]{2})([0-9]{2})([0-9]{2})$/;
const MIN_YEAR = 1970;

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isValidTimestamp({ year, month, day, hour, minute }: SnapshotTimestamp): boolean {
  return (
    year >= MIN_YEAR &&
    year <= 9999 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month) &&
    hour <= 23 &&
    minute <= 59
  );
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/**
 * Formats the human-readable snapshot name `VM_NAME_YYYYMMDDhhmm`, using UTC so that names sort
 * consistently across agents in different time zones.
 *
 * Snapshot names are labels, not identifiers: two snapshots of a VM taken within the same minute
 * have the same name. Use the version ID to refer to a version.
 */
export function formatSnapshotName(vmName: string, at: Date): string {
  const validation = validateVmName(vmName);
  if (!validation.ok) {
    throw new Error(`Invalid VM name (${validation.code})`);
  }
  if (Number.isNaN(at.getTime())) {
    throw new Error('Invalid snapshot time');
  }
  const timestamp: SnapshotTimestamp = {
    year: at.getUTCFullYear(),
    month: at.getUTCMonth() + 1,
    day: at.getUTCDate(),
    hour: at.getUTCHours(),
    minute: at.getUTCMinutes(),
  };
  if (!isValidTimestamp(timestamp)) {
    throw new Error('Snapshot time is out of range');
  }
  const { year, month, day, hour, minute } = timestamp;
  return `${vmName}_${pad(year, 4)}${pad(month, 2)}${pad(day, 2)}${pad(hour, 2)}${pad(minute, 2)}`;
}

/** Returns the parts of a snapshot name, or `null` if it does not follow the convention. */
export function parseSnapshotName(name: string): ParsedSnapshotName | null {
  const match = SNAPSHOT_NAME.exec(name);
  if (!match) return null;
  const [, vmName = '', year, month, day, hour, minute] = match;
  if (!validateVmName(vmName).ok) return null;
  const timestamp: SnapshotTimestamp = {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: Number(hour),
    minute: Number(minute),
  };
  return isValidTimestamp(timestamp) ? { vmName, timestamp } : null;
}

export function isValidSnapshotName(name: string): boolean {
  return parseSnapshotName(name) !== null;
}
