// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import {
  Accordion,
  ActionIcon,
  Box,
  Button,
  Card,
  Checkbox,
  Divider,
  Group,
  Modal,
  NumberInput,
  Select,
  Stack,
  Switch,
  Tabs,
  Text,
  TextInput,
  Title,
  Badge,
  Collapse,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { showNotification } from '@mantine/notifications';
import { createReference, getExtensionValue, getReferenceString } from '@medplum/core';
import type { WithId } from '@medplum/core';
import type { CodeableConcept, Extension, Schedule, Slot } from '@medplum/fhirtypes';
import { CodeableConceptInput, CodeableConceptDisplay, useMedplum } from '@medplum/react';
import {
  IconCalendar,
  IconClock,
  IconSettings,
  IconPlus,
  IconTrash,
  IconInfoCircle,
  IconBuildingStore,
  IconBan,
  IconCopy,
  IconChevronRight,
  IconChevronDown,
} from '@tabler/icons-react';
import { useState, useEffect, useCallback } from 'react';
import type { JSX } from 'react';
import { showErrorNotification } from '../../utils/notifications';

const SchedulingParametersURI = 'https://medplum.com/fhir/StructureDefinition/SchedulingParameters';

type DayOfWeek = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

// ─── Data model ──────────────────────────────────────────────────────────────

interface TimeWindow {
  startTime: string; // "09:00"
  endTime: string; // "17:00"
}

interface DaySchedule {
  enabled: boolean;
  timeWindows: TimeWindow[];
}

type WeekSchedule = Record<DayOfWeek, DaySchedule>;

interface BookingLimit {
  frequency: number;
  period: number;
  periodUnit: 'd' | 'wk' | 'mo';
}

interface BlockedTime {
  allDay: boolean;
  startDate: string; // "2026-02-15"
  endDate: string; // "2026-02-15" (same for single day)
  startTime: string; // "14:00" (only when !allDay)
  endTime: string; // "15:00" (only when !allDay)
  comment: string;
}

// ─── US Federal Holidays ─────────────────────────────────────────────────────

interface Holiday {
  name: string;
  date: string; // "YYYY-MM-DD"
}

/** Nth weekday of a month (1-indexed). E.g., nthWeekday(2026, 0, 1, 3) = 3rd Monday of Jan 2026 */
function nthWeekday(year: number, month: number, weekday: number, n: number): Date {
  const first = new Date(year, month, 1);
  let dayOfFirst = first.getDay();
  let diff = weekday - dayOfFirst;
  if (diff < 0) {
    diff += 7;
  }
  const day = 1 + diff + (n - 1) * 7;
  return new Date(year, month, day);
}

/** Last weekday of a month. E.g., lastWeekday(2026, 4, 1) = last Monday of May 2026 */
function lastWeekday(year: number, month: number, weekday: number): Date {
  const last = new Date(year, month + 1, 0); // last day of month
  let diff = last.getDay() - weekday;
  if (diff < 0) {
    diff += 7;
  }
  return new Date(year, month, last.getDate() - diff);
}

function toDateStr(d: Date): string {
  return d.toISOString().substring(0, 10);
}

function getFederalHolidays(year: number): Holiday[] {
  return [
    { name: "New Year's Day", date: `${year}-01-01` },
    { name: 'Martin Luther King Jr. Day', date: toDateStr(nthWeekday(year, 0, 1, 3)) },
    { name: "Presidents' Day", date: toDateStr(nthWeekday(year, 1, 1, 3)) },
    { name: 'Memorial Day', date: toDateStr(lastWeekday(year, 4, 1)) },
    { name: 'Juneteenth', date: `${year}-06-19` },
    { name: 'Independence Day', date: `${year}-07-04` },
    { name: 'Labor Day', date: toDateStr(nthWeekday(year, 8, 1, 1)) },
    { name: 'Columbus Day', date: toDateStr(nthWeekday(year, 9, 1, 2)) },
    { name: 'Veterans Day', date: `${year}-11-11` },
    { name: 'Thanksgiving', date: toDateStr(nthWeekday(year, 10, 4, 4)) },
    { name: 'Christmas Day', date: `${year}-12-25` },
  ];
}

interface ServiceTypeOverride {
  serviceType: CodeableConcept;
  durationValue: number;
  durationUnit: 'min' | 'h';
  weekSchedule: WeekSchedule;
  bufferBefore: number;
  bufferAfter: number;
  alignmentInterval: number;
  alignmentOffset: number;
  bookingLimits: BookingLimit[];
  timezone?: string;
}

interface AvailabilityFormValues {
  durationValue: number;
  durationUnit: 'min' | 'h' | 'd' | 'wk';
  weekSchedule: WeekSchedule;
  bufferBefore: number;
  bufferAfter: number;
  alignmentInterval: number;
  alignmentOffset: number;
  bookingLimits: BookingLimit[];
  timezone: string;
  serviceTypeOverrides: ServiceTypeOverride[];
}

// ─── Props ───────────────────────────────────────────────────────────────────

interface SetAvailabilityModalProps {
  opened: boolean;
  onClose: () => void;
  schedule: Schedule;
  onSave: (schedule: Schedule) => void;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const ORDERED_DAYS: { value: DayOfWeek; label: string; short: string }[] = [
  { value: 'mon', label: 'Monday', short: 'Mon' },
  { value: 'tue', label: 'Tuesday', short: 'Tue' },
  { value: 'wed', label: 'Wednesday', short: 'Wed' },
  { value: 'thu', label: 'Thursday', short: 'Thu' },
  { value: 'fri', label: 'Friday', short: 'Fri' },
  { value: 'sat', label: 'Saturday', short: 'Sat' },
  { value: 'sun', label: 'Sunday', short: 'Sun' },
];

const DEFAULT_WINDOW: TimeWindow = { startTime: '09:00', endTime: '17:00' };

const COMMON_TIMEZONES = [
  { value: 'America/New_York', label: 'Eastern Time (ET)' },
  { value: 'America/Chicago', label: 'Central Time (CT)' },
  { value: 'America/Denver', label: 'Mountain Time (MT)' },
  { value: 'America/Los_Angeles', label: 'Pacific Time (PT)' },
  { value: 'America/Phoenix', label: 'Arizona Time' },
  { value: 'America/Anchorage', label: 'Alaska Time' },
  { value: 'Pacific/Honolulu', label: 'Hawaii Time' },
];

function makeDefaultWeek(): WeekSchedule {
  return {
    mon: { enabled: true, timeWindows: [{ ...DEFAULT_WINDOW }] },
    tue: { enabled: true, timeWindows: [{ ...DEFAULT_WINDOW }] },
    wed: { enabled: true, timeWindows: [{ ...DEFAULT_WINDOW }] },
    thu: { enabled: true, timeWindows: [{ ...DEFAULT_WINDOW }] },
    fri: { enabled: true, timeWindows: [{ ...DEFAULT_WINDOW }] },
    sat: { enabled: false, timeWindows: [] },
    sun: { enabled: false, timeWindows: [] },
  };
}

// ─── Time helpers ────────────────────────────────────────────────────────────

function timeToMinutes(time: string): number {
  const parts = time.split(':').map(Number);
  return (parts[0] ?? 0) * 60 + (parts[1] ?? 0);
}

function minutesToTime(m: number): string {
  const hh = String(Math.floor(m / 60) % 24).padStart(2, '0');
  const mm = String(m % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

function fhirToTimeWindow(startTime: string, durationHours: number): TimeWindow {
  const startMinutes = timeToMinutes(startTime);
  const endMinutes = startMinutes + durationHours * 60;
  return {
    startTime: startTime.substring(0, 5),
    endTime: minutesToTime(endMinutes),
  };
}

function timeWindowDurationHours(tw: TimeWindow): number {
  const s = timeToMinutes(tw.startTime);
  const e = timeToMinutes(tw.endTime);
  let diff = e - s;
  if (diff <= 0) {
    diff += 24 * 60;
  }
  return diff / 60;
}

function formatDuration(tw: TimeWindow): string {
  const s = timeToMinutes(tw.startTime);
  const e = timeToMinutes(tw.endTime);
  let diff = e - s;
  if (diff <= 0) {
    diff += 24 * 60;
  }
  const h = Math.floor(diff / 60);
  const m = diff % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

// ─── FHIR Parsing ────────────────────────────────────────────────────────────

function parseWeekScheduleFromExtension(ext: Extension): WeekSchedule {
  const availabilities = ext.extension?.filter((sub) => sub.url === 'availability') ?? [];

  // Start with everything off
  const week: WeekSchedule = {
    mon: { enabled: false, timeWindows: [] },
    tue: { enabled: false, timeWindows: [] },
    wed: { enabled: false, timeWindows: [] },
    thu: { enabled: false, timeWindows: [] },
    fri: { enabled: false, timeWindows: [] },
    sat: { enabled: false, timeWindows: [] },
    sun: { enabled: false, timeWindows: [] },
  };

  for (const avail of availabilities) {
    const repeat = (avail.valueTiming as Record<string, unknown>)?.repeat as
      | {
          dayOfWeek?: string[];
          timeOfDay?: string[];
          duration?: number;
          durationUnit?: string;
        }
      | undefined;

    if (!repeat) {
      continue;
    }

    const days = (repeat.dayOfWeek ?? []) as DayOfWeek[];
    const dur = repeat.duration ?? 8;
    const durUnit = repeat.durationUnit ?? 'h';
    const durHours = durUnit === 'h' ? dur : dur / 60;
    const times = repeat.timeOfDay ?? ['09:00:00'];

    for (const day of days) {
      if (week[day]) {
        week[day].enabled = true;
        for (const time of times) {
          week[day].timeWindows.push(fhirToTimeWindow(time, durHours));
        }
      }
    }
  }

  // For enabled days with no windows, add a default
  for (const day of ORDERED_DAYS) {
    if (week[day.value].enabled && week[day.value].timeWindows.length === 0) {
      week[day.value].timeWindows.push({ ...DEFAULT_WINDOW });
    }
  }

  return week;
}

function parseScheduleExtensions(schedule: Schedule): AvailabilityFormValues {
  const extensions = schedule?.extension?.filter((ext) => ext.url === SchedulingParametersURI) ?? [];

  const defaultExtension = extensions.find((ext) => {
    const st = getExtensionValue(ext, 'serviceType') as CodeableConcept | undefined;
    return !st;
  });

  const serviceExtensions = extensions.filter((ext) => {
    const st = getExtensionValue(ext, 'serviceType') as CodeableConcept | undefined;
    return !!st;
  });

  let defaultValues: Partial<AvailabilityFormValues> = {};

  if (defaultExtension) {
    const duration = getExtensionValue(defaultExtension, 'duration') as { value: number; unit: string } | undefined;
    const bufferBefore = getExtensionValue(defaultExtension, 'bufferBefore') as
      | { value: number; unit: string }
      | undefined;
    const bufferAfter = getExtensionValue(defaultExtension, 'bufferAfter') as
      | { value: number; unit: string }
      | undefined;
    const alignmentInterval = getExtensionValue(defaultExtension, 'alignmentInterval') as
      | { value: number; unit: string }
      | undefined;
    const alignmentOffset = getExtensionValue(defaultExtension, 'alignmentOffset') as
      | { value: number; unit: string }
      | undefined;
    const bookingLimitExts = defaultExtension.extension?.filter((sub) => sub.url === 'bookingLimit') ?? [];
    const timezone = getExtensionValue(defaultExtension, 'timezone') as string | undefined;

    const weekSchedule = parseWeekScheduleFromExtension(defaultExtension);

    const parsedBookingLimits: BookingLimit[] = bookingLimitExts.map((sub) => {
      const timing = sub.valueTiming as {
        repeat?: { frequency?: number; period?: number; periodUnit?: string };
      };
      return {
        frequency: timing?.repeat?.frequency ?? 0,
        period: timing?.repeat?.period ?? 1,
        periodUnit: (timing?.repeat?.periodUnit as 'd' | 'wk' | 'mo') ?? 'd',
      };
    });

    defaultValues = {
      durationValue: duration?.value ?? 30,
      durationUnit: (duration?.unit as 'min' | 'h') ?? 'min',
      weekSchedule,
      bufferBefore: bufferBefore ? (bufferBefore.unit === 'h' ? bufferBefore.value * 60 : bufferBefore.value) : 0,
      bufferAfter: bufferAfter ? (bufferAfter.unit === 'h' ? bufferAfter.value * 60 : bufferAfter.value) : 0,
      alignmentInterval: alignmentInterval
        ? alignmentInterval.unit === 'h'
          ? alignmentInterval.value * 60
          : alignmentInterval.value
        : 0,
      alignmentOffset: alignmentOffset
        ? alignmentOffset.unit === 'h'
          ? alignmentOffset.value * 60
          : alignmentOffset.value
        : 0,
      bookingLimits: parsedBookingLimits,
      timezone: timezone ?? '',
    };
  }

  // Parse service overrides
  const serviceTypeOverrides: ServiceTypeOverride[] = serviceExtensions.map((ext) => {
    const serviceType = getExtensionValue(ext, 'serviceType') as CodeableConcept;
    const duration = getExtensionValue(ext, 'duration') as { value: number; unit: string } | undefined;
    const bufferBefore = getExtensionValue(ext, 'bufferBefore') as { value: number; unit: string } | undefined;
    const bufferAfter = getExtensionValue(ext, 'bufferAfter') as { value: number; unit: string } | undefined;
    const alignmentInterval = getExtensionValue(ext, 'alignmentInterval') as
      | { value: number; unit: string }
      | undefined;
    const alignmentOffset = getExtensionValue(ext, 'alignmentOffset') as { value: number; unit: string } | undefined;
    const bookingLimitExts = ext.extension?.filter((sub) => sub.url === 'bookingLimit') ?? [];
    const timezone = getExtensionValue(ext, 'timezone') as string | undefined;

    const weekSchedule = parseWeekScheduleFromExtension(ext);

    const parsedBookingLimits: BookingLimit[] = bookingLimitExts.map((sub) => {
      const timing = sub.valueTiming as {
        repeat?: { frequency?: number; period?: number; periodUnit?: string };
      };
      return {
        frequency: timing?.repeat?.frequency ?? 0,
        period: timing?.repeat?.period ?? 1,
        periodUnit: (timing?.repeat?.periodUnit as 'd' | 'wk' | 'mo') ?? 'd',
      };
    });

    return {
      serviceType,
      durationValue: duration?.value ?? 30,
      durationUnit: (duration?.unit as 'min' | 'h') ?? 'min',
      weekSchedule,
      bufferBefore: bufferBefore ? (bufferBefore.unit === 'h' ? bufferBefore.value * 60 : bufferBefore.value) : 0,
      bufferAfter: bufferAfter ? (bufferAfter.unit === 'h' ? bufferAfter.value * 60 : bufferAfter.value) : 0,
      alignmentInterval: alignmentInterval
        ? alignmentInterval.unit === 'h'
          ? alignmentInterval.value * 60
          : alignmentInterval.value
        : 0,
      alignmentOffset: alignmentOffset
        ? alignmentOffset.unit === 'h'
          ? alignmentOffset.value * 60
          : alignmentOffset.value
        : 0,
      bookingLimits: parsedBookingLimits,
      timezone: timezone,
    };
  });

  return {
    durationValue: defaultValues.durationValue ?? 30,
    durationUnit: defaultValues.durationUnit ?? 'min',
    weekSchedule: defaultValues.weekSchedule ?? makeDefaultWeek(),
    bufferBefore: defaultValues.bufferBefore ?? 0,
    bufferAfter: defaultValues.bufferAfter ?? 0,
    alignmentInterval: defaultValues.alignmentInterval ?? 0,
    alignmentOffset: defaultValues.alignmentOffset ?? 0,
    bookingLimits: defaultValues.bookingLimits ?? [],
    timezone: defaultValues.timezone ?? '',
    serviceTypeOverrides,
  };
}

// ─── FHIR Extension Building ─────────────────────────────────────────────────

/**
 * Build `availability` sub-extensions from a WeekSchedule.
 * Groups days that share identical time windows into a single FHIR Timing entry
 * for efficiency. Different duration windows on the same day get separate entries.
 */
function buildAvailabilityExtensions(weekSchedule: WeekSchedule): Extension[] {
  // Collect all (day, startTime, endTime) tuples
  interface WindowEntry {
    day: DayOfWeek;
    startTime: string;
    durationHours: number;
  }

  const entries: WindowEntry[] = [];
  for (const dayInfo of ORDERED_DAYS) {
    const ds = weekSchedule[dayInfo.value];
    if (!ds.enabled) {
      continue;
    }
    for (const tw of ds.timeWindows) {
      entries.push({
        day: dayInfo.value,
        startTime: tw.startTime.length === 5 ? `${tw.startTime}:00` : tw.startTime,
        durationHours: timeWindowDurationHours(tw),
      });
    }
  }

  // Group by (startTime, durationHours) → days[]
  const groups = new Map<string, { startTime: string; durationHours: number; days: DayOfWeek[] }>();
  for (const e of entries) {
    const key = `${e.startTime}|${Math.round(e.durationHours * 100)}`;
    const existing = groups.get(key);
    if (existing) {
      if (!existing.days.includes(e.day)) {
        existing.days.push(e.day);
      }
    } else {
      groups.set(key, { startTime: e.startTime, durationHours: e.durationHours, days: [e.day] });
    }
  }

  // Now further group entries that share the same days + duration but different start times
  // into a single Timing with multiple timeOfDay entries
  const superGroups = new Map<
    string,
    { days: DayOfWeek[]; durationHours: number; times: string[] }
  >();
  for (const g of groups.values()) {
    const daysKey = g.days.sort().join(',');
    const durKey = Math.round(g.durationHours * 100);
    const superKey = `${daysKey}|${durKey}`;
    const existing = superGroups.get(superKey);
    if (existing) {
      existing.times.push(g.startTime);
    } else {
      superGroups.set(superKey, { days: [...g.days], durationHours: g.durationHours, times: [g.startTime] });
    }
  }

  const result: Extension[] = [];
  for (const sg of superGroups.values()) {
    result.push({
      url: 'availability',
      valueTiming: {
        repeat: {
          dayOfWeek: sg.days,
          timeOfDay: sg.times,
          duration: sg.durationHours,
          durationUnit: 'h',
        },
      },
    });
  }

  return result;
}

function buildSchedulingParametersExtensions(values: AvailabilityFormValues): Extension[] {
  const extensions: Extension[] = [];

  // Default extension
  const defaultSubs: Extension[] = [];

  defaultSubs.push({ url: 'duration', valueDuration: { value: values.durationValue, unit: values.durationUnit } });
  defaultSubs.push(...buildAvailabilityExtensions(values.weekSchedule));

  if (values.bufferBefore > 0) {
    defaultSubs.push({ url: 'bufferBefore', valueDuration: { value: values.bufferBefore, unit: 'min' } });
  }
  if (values.bufferAfter > 0) {
    defaultSubs.push({ url: 'bufferAfter', valueDuration: { value: values.bufferAfter, unit: 'min' } });
  }
  if (values.alignmentInterval > 0) {
    defaultSubs.push({
      url: 'alignmentInterval',
      valueDuration: { value: values.alignmentInterval, unit: 'min' },
    });
    if (values.alignmentOffset > 0) {
      defaultSubs.push({
        url: 'alignmentOffset',
        valueDuration: { value: values.alignmentOffset, unit: 'min' },
      });
    }
  }
  values.bookingLimits.forEach((limit) => {
    if (limit.frequency > 0) {
      defaultSubs.push({
        url: 'bookingLimit',
        valueTiming: {
          repeat: { frequency: limit.frequency, period: limit.period, periodUnit: limit.periodUnit },
        },
      });
    }
  });
  if (values.timezone) {
    defaultSubs.push({ url: 'timezone', valueCode: values.timezone });
  }

  extensions.push({ url: SchedulingParametersURI, extension: defaultSubs });

  // Service overrides
  values.serviceTypeOverrides.forEach((override) => {
    const subs: Extension[] = [];
    subs.push({ url: 'serviceType', valueCodeableConcept: override.serviceType });
    subs.push({ url: 'duration', valueDuration: { value: override.durationValue, unit: override.durationUnit } });
    subs.push(...buildAvailabilityExtensions(override.weekSchedule));

    if (override.bufferBefore > 0) {
      subs.push({ url: 'bufferBefore', valueDuration: { value: override.bufferBefore, unit: 'min' } });
    }
    if (override.bufferAfter > 0) {
      subs.push({ url: 'bufferAfter', valueDuration: { value: override.bufferAfter, unit: 'min' } });
    }
    if (override.alignmentInterval > 0) {
      subs.push({ url: 'alignmentInterval', valueDuration: { value: override.alignmentInterval, unit: 'min' } });
      if (override.alignmentOffset > 0) {
        subs.push({ url: 'alignmentOffset', valueDuration: { value: override.alignmentOffset, unit: 'min' } });
      }
    }
    override.bookingLimits.forEach((limit) => {
      if (limit.frequency > 0) {
        subs.push({
          url: 'bookingLimit',
          valueTiming: {
            repeat: { frequency: limit.frequency, period: limit.period, periodUnit: limit.periodUnit },
          },
        });
      }
    });
    if (override.timezone) {
      subs.push({ url: 'timezone', valueCode: override.timezone });
    }

    extensions.push({ url: SchedulingParametersURI, extension: subs });
  });

  return extensions;
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function TimeWindowRow({
  tw,
  index,
  onChange,
  onRemove,
  canRemove,
}: {
  tw: TimeWindow;
  index: number;
  onChange: (idx: number, tw: TimeWindow) => void;
  onRemove: (idx: number) => void;
  canRemove: boolean;
}): JSX.Element {
  return (
    <Group gap="xs" wrap="nowrap">
      <TextInput
        type="time"
        value={tw.startTime}
        onChange={(e) => {
          const newStart = e.target.value;
          // Auto-set end time to 1 hour after the new start time
          const [hStr, mStr] = newStart.split(':');
          const h = parseInt(hStr, 10);
          const m = parseInt(mStr, 10);
          if (!isNaN(h) && !isNaN(m)) {
            const endH = (h + 1) % 24;
            const newEnd = `${String(endH).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
            onChange(index, { ...tw, startTime: newStart, endTime: newEnd });
          } else {
            onChange(index, { ...tw, startTime: newStart });
          }
        }}
        size="xs"
        style={{ width: 110 }}
        aria-label="Start time"
      />
      <Text size="xs" c="dimmed">
        to
      </Text>
      <TextInput
        type="time"
        value={tw.endTime}
        onChange={(e) => onChange(index, { ...tw, endTime: e.target.value })}
        size="xs"
        style={{ width: 110 }}
        aria-label="End time"
      />
      <Text size="xs" c="dimmed" style={{ minWidth: 40 }}>
        {formatDuration(tw)}
      </Text>
      {canRemove && (
        <ActionIcon color="red" variant="subtle" size="xs" onClick={() => onRemove(index)} aria-label="Remove window">
          <IconTrash size={14} />
        </ActionIcon>
      )}
    </Group>
  );
}

function DayRow({
  day,
  daySchedule,
  onChange,
}: {
  day: { value: DayOfWeek; label: string; short: string };
  daySchedule: DaySchedule;
  onChange: (ds: DaySchedule) => void;
}): JSX.Element {
  const updateWindow = (idx: number, tw: TimeWindow): void => {
    const next = [...daySchedule.timeWindows];
    next[idx] = tw;
    onChange({ ...daySchedule, timeWindows: next });
  };

  const removeWindow = (idx: number): void => {
    const next = daySchedule.timeWindows.filter((_, i) => i !== idx);
    onChange({ ...daySchedule, timeWindows: next.length > 0 ? next : [{ ...DEFAULT_WINDOW }] });
  };

  const addWindow = (): void => {
    onChange({ ...daySchedule, timeWindows: [...daySchedule.timeWindows, { startTime: '13:00', endTime: '17:00' }] });
  };

  return (
    <Group
      gap="sm"
      align="flex-start"
      wrap="nowrap"
      py={6}
      style={{ borderBottom: '1px solid #f1f3f5' }}
    >
      {/* Day label + toggle */}
      <Box style={{ width: 80, flexShrink: 0, paddingTop: 4 }}>
        <Switch
          label={day.short}
          checked={daySchedule.enabled}
          onChange={(e) =>
            onChange({
              enabled: e.currentTarget.checked,
              timeWindows: e.currentTarget.checked && daySchedule.timeWindows.length === 0
                ? [{ ...DEFAULT_WINDOW }]
                : daySchedule.timeWindows,
            })
          }
          size="xs"
          styles={{ label: { fontWeight: 600, fontSize: 13 } }}
        />
      </Box>

      {/* Time windows or OFF label */}
      {daySchedule.enabled ? (
        <Stack gap={4} style={{ flex: 1 }}>
          {daySchedule.timeWindows.map((tw, i) => (
            <TimeWindowRow
              key={i}
              tw={tw}
              index={i}
              onChange={updateWindow}
              onRemove={removeWindow}
              canRemove={daySchedule.timeWindows.length > 1}
            />
          ))}
          <Button
            size="compact-xs"
            variant="subtle"
            leftSection={<IconPlus size={12} />}
            onClick={addWindow}
            style={{ alignSelf: 'flex-start' }}
          >
            Add
          </Button>
        </Stack>
      ) : (
        <Text size="sm" c="dimmed" pt={4}>
          OFF
        </Text>
      )}
    </Group>
  );
}

function BookingLimitInput({
  limit,
  index,
  onChange,
  onRemove,
}: {
  limit: BookingLimit;
  index: number;
  onChange: (idx: number, limit: BookingLimit) => void;
  onRemove: (idx: number) => void;
}): JSX.Element {
  return (
    <Card withBorder p="sm" radius="md" style={{ position: 'relative' }}>
      <ActionIcon
        color="red"
        variant="subtle"
        size="sm"
        style={{ position: 'absolute', top: 8, right: 8 }}
        onClick={() => onRemove(index)}
        aria-label="Remove booking limit"
      >
        <IconTrash size={16} />
      </ActionIcon>
      <Group gap="xs" align="flex-end">
        <NumberInput
          label="Max Appointments"
          value={limit.frequency}
          onChange={(v) => onChange(index, { ...limit, frequency: Number(v) || 0 })}
          min={0}
          size="xs"
          style={{ flex: 1 }}
        />
        <Text size="xs" pb={6}>
          per
        </Text>
        <NumberInput
          value={limit.period}
          onChange={(v) => onChange(index, { ...limit, period: Number(v) || 1 })}
          min={1}
          size="xs"
          style={{ width: 60 }}
        />
        <Select
          value={limit.periodUnit}
          onChange={(v) => onChange(index, { ...limit, periodUnit: (v as 'd' | 'wk' | 'mo') || 'd' })}
          data={[
            { value: 'd', label: 'Day(s)' },
            { value: 'wk', label: 'Week(s)' },
            { value: 'mo', label: 'Month(s)' },
          ]}
          size="xs"
          style={{ width: 95 }}
        />
      </Group>
    </Card>
  );
}

// ─── Availability Fields (shared between Default & Override forms) ────────────

interface AvailabilityFieldsProps {
  weekSchedule: WeekSchedule;
  setWeekSchedule: (ws: WeekSchedule) => void;
  durationValue: number;
  durationUnit: 'min' | 'h';
  setDuration: (v: number, u: 'min' | 'h') => void;
  bufferBefore: number;
  bufferAfter: number;
  setBufferBefore: (v: number) => void;
  setBufferAfter: (v: number) => void;
  alignmentInterval: number;
  alignmentOffset: number;
  setAlignmentInterval: (v: number) => void;
  setAlignmentOffset: (v: number) => void;
  bookingLimits: BookingLimit[];
  setBookingLimits: (limits: BookingLimit[]) => void;
  timezone?: string;
  setTimezone?: (tz: string) => void;
}

function AvailabilityFields(props: AvailabilityFieldsProps): JSX.Element {
  const {
    weekSchedule,
    setWeekSchedule,
    durationValue,
    durationUnit,
    setDuration,
    bufferBefore,
    bufferAfter,
    setBufferBefore,
    setBufferAfter,
    alignmentInterval,
    alignmentOffset,
    setAlignmentInterval,
    setAlignmentOffset,
    bookingLimits,
    setBookingLimits,
    timezone,
    setTimezone,
  } = props;

  const updateDay = (day: DayOfWeek, ds: DaySchedule): void => {
    setWeekSchedule({ ...weekSchedule, [day]: ds });
  };

  /** Copy the first enabled day's windows to all other enabled days. */
  const copyFirstToAll = (): void => {
    const firstEnabled = ORDERED_DAYS.find((d) => weekSchedule[d.value].enabled);
    if (!firstEnabled) {
      return;
    }
    const src = weekSchedule[firstEnabled.value].timeWindows;
    const next = { ...weekSchedule };
    for (const d of ORDERED_DAYS) {
      if (next[d.value].enabled) {
        next[d.value] = { ...next[d.value], timeWindows: src.map((tw) => ({ ...tw })) };
      }
    }
    setWeekSchedule(next);
  };

  return (
    <Stack gap="md">
      {/* Duration */}
      <Box>
        <Group gap="xs" mb="xs">
          <Text fw={600} size="sm">
            Appointment Duration
          </Text>
          <Tooltip label="Default length for appointment slots">
            <IconInfoCircle size={14} style={{ cursor: 'help' }} />
          </Tooltip>
        </Group>
        <Group gap="xs">
          <NumberInput
            value={durationValue}
            onChange={(v) => setDuration(Number(v) || 30, durationUnit)}
            min={1}
            style={{ flex: 1 }}
            placeholder="30"
            size="sm"
          />
          <Select
            value={durationUnit}
            onChange={(v) => setDuration(durationValue, (v as 'min' | 'h') || 'min')}
            data={[
              { value: 'min', label: 'Minutes' },
              { value: 'h', label: 'Hours' },
            ]}
            style={{ width: 120 }}
            size="sm"
          />
        </Group>
      </Box>

      <Divider />

      {/* Weekly schedule */}
      <Box>
        <Group gap="xs" mb="sm" justify="space-between">
          <Group gap="xs">
            <IconClock size={16} />
            <Text fw={600} size="sm">
              Weekly Hours
            </Text>
          </Group>
          <Button size="compact-xs" variant="subtle" leftSection={<IconCopy size={12} />} onClick={copyFirstToAll}>
            Copy to all
          </Button>
        </Group>

        <Stack gap={0}>
          {ORDERED_DAYS.map((day) => (
            <DayRow
              key={day.value}
              day={day}
              daySchedule={weekSchedule[day.value]}
              onChange={(ds) => updateDay(day.value, ds)}
            />
          ))}
        </Stack>
      </Box>

      <Divider />

      {/* Buffers */}
      <Box>
        <Text fw={600} size="sm" mb="xs">
          Buffer Times
        </Text>
        <Group gap="xs">
          <NumberInput
            value={bufferBefore}
            onChange={(v) => setBufferBefore(Number(v) || 0)}
            label="Before (min)"
            min={0}
            style={{ flex: 1 }}
            size="sm"
            description="Prep time"
          />
          <NumberInput
            value={bufferAfter}
            onChange={(v) => setBufferAfter(Number(v) || 0)}
            label="After (min)"
            min={0}
            style={{ flex: 1 }}
            size="sm"
            description="Cleanup time"
          />
        </Group>
      </Box>

      <Divider />

      {/* Alignment */}
      <Box>
        <Text fw={600} size="sm" mb="xs">
          Time Alignment
        </Text>
        <Group gap="xs">
          <NumberInput
            value={alignmentInterval}
            onChange={(v) => setAlignmentInterval(Number(v) || 0)}
            label="Interval (min)"
            min={0}
            step={5}
            style={{ flex: 1 }}
            size="sm"
            description="e.g., 15 = every 15 min"
          />
          <NumberInput
            value={alignmentOffset}
            onChange={(v) => setAlignmentOffset(Number(v) || 0)}
            label="Offset (min)"
            min={0}
            step={5}
            style={{ flex: 1 }}
            size="sm"
            description="Shift from boundaries"
            disabled={alignmentInterval === 0}
          />
        </Group>
      </Box>

      <Divider />

      {/* Booking Limits */}
      <Box>
        <Group justify="space-between" mb="xs">
          <Text fw={600} size="sm">
            Booking Limits
          </Text>
          <Button
            size="compact-xs"
            variant="light"
            leftSection={<IconPlus size={12} />}
            onClick={() => setBookingLimits([...bookingLimits, { frequency: 0, period: 1, periodUnit: 'd' }])}
          >
            Add Limit
          </Button>
        </Group>
        <Stack gap="sm">
          {bookingLimits.map((limit, i) => (
            <BookingLimitInput
              key={i}
              limit={limit}
              index={i}
              onChange={(idx, updated) => {
                const next = [...bookingLimits];
                next[idx] = updated;
                setBookingLimits(next);
              }}
              onRemove={(idx) => setBookingLimits(bookingLimits.filter((_, j) => j !== idx))}
            />
          ))}
          {bookingLimits.length === 0 && (
            <Text size="xs" c="dimmed">
              No booking limits.
            </Text>
          )}
        </Stack>
      </Box>

      {/* Timezone */}
      {setTimezone && (
        <>
          <Divider />
          <Select
            label="Timezone"
            value={timezone ?? ''}
            onChange={(v) => setTimezone(v || '')}
            data={COMMON_TIMEZONES}
            searchable
            clearable
            placeholder="Select (optional)"
            description="Leave empty for default"
            size="sm"
          />
        </>
      )}
    </Stack>
  );
}

// ─── Main Modal ──────────────────────────────────────────────────────────────

export function SetAvailabilityModal(props: SetAvailabilityModalProps): JSX.Element {
  const { opened, onClose, schedule, onSave } = props;
  const medplum = useMedplum();
  const [isLoading, setIsLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<string>('default');
  const [formValues, setFormValues] = useState<AvailabilityFormValues>(() => parseScheduleExtensions(schedule));

  // Block-time state
  const [blockedTimes, setBlockedTimes] = useState<BlockedTime[]>([]);
  const [blockSaving, setBlockSaving] = useState(false);

  // Existing blocked slots from the server
  const [existingBlocks, setExistingBlocks] = useState<WithId<Slot>[]>([]);
  const [loadingBlocks, setLoadingBlocks] = useState(false);
  const [showPastBlocks, setShowPastBlocks] = useState(false);

  // Fetch existing busy-unavailable slots when modal opens
  const fetchExistingBlocks = useCallback(async () => {
    setLoadingBlocks(true);
    try {
      const results = await medplum.searchResources('Slot', [
        ['schedule', getReferenceString(schedule)],
        ['status', 'busy-unavailable'],
        ['_count', '200'],
        ['_sort', 'start'],
      ]);
      setExistingBlocks(results);
    } catch (error) {
      showErrorNotification(error);
    } finally {
      setLoadingBlocks(false);
    }
  }, [medplum, schedule]);

  useEffect(() => {
    if (opened) {
      setFormValues(parseScheduleExtensions(schedule));
      setActiveTab('default');
      setBlockedTimes([]);
      fetchExistingBlocks();
    }
  }, [opened, schedule, fetchExistingBlocks]);

  // Delete an existing blocked slot (with confirmation)
  const handleDeleteBlock = useCallback(
    async (slot: WithId<Slot>) => {
      if (!window.confirm('Remove this block? This cannot be undone.')) {
        return;
      }
      try {
        await medplum.deleteResource('Slot', slot.id);
        setExistingBlocks((prev) => prev.filter((s) => s.id !== slot.id));
        medplum.invalidateSearches('Slot');
        showNotification({ title: 'Block Removed', message: 'Time block deleted', color: 'green' });
      } catch (error) {
        showErrorNotification(error);
      }
    },
    [medplum]
  );

  // Bulk-delete all past blocks
  const handleClearPastBlocks = useCallback(async () => {
    const now = new Date();
    const pastBlocks = existingBlocks.filter((s) => new Date(s.end) < now);
    if (pastBlocks.length === 0) {
      return;
    }
    if (!window.confirm(`Remove ${pastBlocks.length} past block${pastBlocks.length !== 1 ? 's' : ''}? This cannot be undone.`)) {
      return;
    }
    try {
      for (const slot of pastBlocks) {
        await medplum.deleteResource('Slot', slot.id);
      }
      setExistingBlocks((prev) => prev.filter((s) => new Date(s.end) >= now));
      medplum.invalidateSearches('Slot');
      setShowPastBlocks(false);
      showNotification({
        title: 'Past Blocks Cleared',
        message: `Removed ${pastBlocks.length} past block${pastBlocks.length !== 1 ? 's' : ''}`,
        color: 'green',
      });
    } catch (error) {
      showErrorNotification(error);
    }
  }, [medplum, existingBlocks]);

  // ── Save availability ──
  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setIsLoading(true);
    try {
      const existingExtensions =
        schedule.extension?.filter((ext) => ext.url !== SchedulingParametersURI) ?? [];
      const newExtensions = buildSchedulingParametersExtensions(formValues);

      const updatedSchedule: Schedule = {
        ...schedule,
        extension: [...existingExtensions, ...newExtensions],
      };

      const saved = await medplum.updateResource(updatedSchedule);
      onSave(saved);
      showNotification({ title: 'Success', message: 'Availability saved', color: 'green' });
      onClose();
    } catch (error) {
      showErrorNotification(error);
    } finally {
      setIsLoading(false);
    }
  }

  // ── Block time helpers ──

  /** Create a single busy-unavailable Slot for a one-time block. */
  const createBlockSlots = useCallback(
    async (block: BlockedTime): Promise<number> => {
      const scheduleRef = createReference(schedule);
      const comment = block.comment || undefined;

      let start: string;
      let end: string;

      if (block.allDay) {
        start = new Date(`${block.startDate}T00:00:00`).toISOString();
        end = new Date(`${block.endDate}T23:59:59`).toISOString();
      } else {
        // Single continuous block: start date+time → end date+time
        start = new Date(`${block.startDate}T${block.startTime}:00`).toISOString();
        end = new Date(`${block.endDate}T${block.endTime}:00`).toISOString();
      }

      await medplum.createResource<Slot>({
        resourceType: 'Slot',
        schedule: scheduleRef,
        status: 'busy-unavailable',
        start,
        end,
        comment,
      });
      return 1;
    },
    [medplum, schedule]
  );

  const handleBlockTime = useCallback(
    async (block: BlockedTime) => {
      setBlockSaving(true);
      try {
        const count = await createBlockSlots(block);
        showNotification({
          title: 'Time Blocked',
          message: count === 1 ? 'Blocked 1 time slot' : `Blocked ${count} time slots`,
          color: 'blue',
        });
        setBlockedTimes((prev) => prev.filter((b) => b !== block));
        medplum.invalidateSearches('Slot');
        fetchExistingBlocks(); // refresh list
      } catch (error) {
        showErrorNotification(error);
      } finally {
        setBlockSaving(false);
      }
    },
    [createBlockSlots, medplum, fetchExistingBlocks]
  );

  /** Block selected holidays in one click. */
  const [selectedHolidays, setSelectedHolidays] = useState<string[]>([]);
  const currentYear = new Date().getFullYear();
  const holidays = getFederalHolidays(currentYear);
  // Also include next year if we're past October
  const nextYearHolidays =
    new Date().getMonth() >= 9 ? getFederalHolidays(currentYear + 1) : [];
  const allHolidays = [...holidays, ...nextYearHolidays];
  // Filter out holidays that have already passed
  const today = new Date().toISOString().substring(0, 10);
  const upcomingHolidays = allHolidays.filter((h) => h.date >= today);

  // Build a set of dates that already have a busy-unavailable slot (to prevent duplicates)
  const alreadyBlockedDates = new Set<string>();
  for (const slot of existingBlocks) {
    const start = new Date(slot.start);
    const end = new Date(slot.end);
    // Add each day in the slot's range
    const cur = new Date(start);
    cur.setHours(0, 0, 0, 0);
    const last = new Date(end);
    last.setHours(0, 0, 0, 0);
    while (cur <= last) {
      alreadyBlockedDates.add(cur.toISOString().substring(0, 10));
      cur.setDate(cur.getDate() + 1);
    }
  }

  // Holidays not yet blocked
  const unblockedHolidays = upcomingHolidays.filter((h) => !alreadyBlockedDates.has(h.date));
  const blockedHolidayNames = upcomingHolidays.filter((h) => alreadyBlockedDates.has(h.date));

  const handleBlockHolidays = useCallback(async () => {
    if (selectedHolidays.length === 0) {
      return;
    }
    setBlockSaving(true);
    try {
      let totalCount = 0;
      for (const date of selectedHolidays) {
        const holiday = allHolidays.find((h) => h.date === date);
        const count = await createBlockSlots({
          allDay: true,
          startDate: date,
          endDate: date,
          startTime: '',
          endTime: '',
          comment: holiday?.name ?? 'Holiday',
        });
        totalCount += count;
      }
      showNotification({
        title: 'Holidays Blocked',
        message: `Blocked ${totalCount} holiday${totalCount !== 1 ? 's' : ''}`,
        color: 'blue',
      });
      setSelectedHolidays([]);
      medplum.invalidateSearches('Slot');
      fetchExistingBlocks(); // refresh list
    } catch (error) {
      showErrorNotification(error);
    } finally {
      setBlockSaving(false);
    }
  }, [selectedHolidays, allHolidays, createBlockSlots, medplum, fetchExistingBlocks]);

  // ── Helpers ──
  function updateDefault(patch: Partial<AvailabilityFormValues>): void {
    setFormValues((prev) => ({ ...prev, ...patch }));
  }

  function updateOverride(index: number, patch: Partial<ServiceTypeOverride>): void {
    setFormValues((prev) => {
      const next = [...prev.serviceTypeOverrides];
      next[index] = { ...next[index], ...patch };
      return { ...prev, serviceTypeOverrides: next };
    });
  }

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={
        <Group gap="xs">
          <IconCalendar size={24} />
          <Title order={3}>Set Availability</Title>
        </Group>
      }
      size="xl"
      centered
      styles={{ body: { maxHeight: '80vh', overflowY: 'auto' } }}
    >
      <form onSubmit={handleSubmit}>
        <Tabs value={activeTab} onChange={(v) => setActiveTab(v ?? 'default')}>
          <Tabs.List>
            <Tabs.Tab value="default" leftSection={<IconSettings size={16} />}>
              Availability
            </Tabs.Tab>
            <Tabs.Tab
              value="service-types"
              leftSection={<IconBuildingStore size={16} />}
              rightSection={
                formValues.serviceTypeOverrides.length > 0 ? (
                  <Badge size="sm" variant="filled" circle>
                    {formValues.serviceTypeOverrides.length}
                  </Badge>
                ) : null
              }
            >
              Service-Specific
            </Tabs.Tab>
            <Tabs.Tab value="block-time" leftSection={<IconBan size={16} />}>
              Block Time
            </Tabs.Tab>
          </Tabs.List>

          {/* ====== DEFAULT AVAILABILITY ====== */}
          <Tabs.Panel value="default" pt="md">
            <AvailabilityFields
              weekSchedule={formValues.weekSchedule}
              setWeekSchedule={(ws) => updateDefault({ weekSchedule: ws })}
              durationValue={formValues.durationValue}
              durationUnit={formValues.durationUnit as 'min' | 'h'}
              setDuration={(v, u) => updateDefault({ durationValue: v, durationUnit: u })}
              bufferBefore={formValues.bufferBefore}
              bufferAfter={formValues.bufferAfter}
              setBufferBefore={(v) => updateDefault({ bufferBefore: v })}
              setBufferAfter={(v) => updateDefault({ bufferAfter: v })}
              alignmentInterval={formValues.alignmentInterval}
              alignmentOffset={formValues.alignmentOffset}
              setAlignmentInterval={(v) => updateDefault({ alignmentInterval: v })}
              setAlignmentOffset={(v) => updateDefault({ alignmentOffset: v })}
              bookingLimits={formValues.bookingLimits}
              setBookingLimits={(limits) => updateDefault({ bookingLimits: limits })}
              timezone={formValues.timezone}
              setTimezone={(tz) => updateDefault({ timezone: tz })}
            />
          </Tabs.Panel>

          {/* ====== SERVICE-SPECIFIC OVERRIDES ====== */}
          <Tabs.Panel value="service-types" pt="md">
            <Stack gap="md">
              <Group justify="space-between">
                <Box>
                  <Text fw={600} size="sm">
                    Service-Specific Overrides
                  </Text>
                  <Text size="xs" c="dimmed">
                    Override default availability per service type
                  </Text>
                </Box>
                <Button
                  size="sm"
                  variant="light"
                  leftSection={<IconPlus size={16} />}
                  onClick={() =>
                    updateDefault({
                      serviceTypeOverrides: [
                        ...formValues.serviceTypeOverrides,
                        {
                          serviceType: { coding: [{ code: '', display: '' }] },
                          durationValue: formValues.durationValue,
                          durationUnit: formValues.durationUnit as 'min' | 'h',
                          weekSchedule: { ...formValues.weekSchedule },
                          bufferBefore: formValues.bufferBefore,
                          bufferAfter: formValues.bufferAfter,
                          alignmentInterval: formValues.alignmentInterval,
                          alignmentOffset: formValues.alignmentOffset,
                          bookingLimits: [],
                        },
                      ],
                    })
                  }
                >
                  Add Override
                </Button>
              </Group>

              {formValues.serviceTypeOverrides.length === 0 ? (
                <Card withBorder p="xl" style={{ textAlign: 'center' }}>
                  <Text c="dimmed">No service-specific overrides</Text>
                  <Text size="xs" c="dimmed" mt="xs">
                    Click "Add Override" to customise per service type
                  </Text>
                </Card>
              ) : (
                <Accordion>
                  {formValues.serviceTypeOverrides.map((override, index) => (
                    <Accordion.Item key={index} value={`override-${index}`}>
                      <Accordion.Control>
                        <Group justify="space-between" style={{ width: '100%' }}>
                          <Box style={{ flex: 1 }}>
                            {override.serviceType.coding?.[0]?.code ? (
                              <CodeableConceptDisplay value={override.serviceType} />
                            ) : (
                              <Text c="dimmed">New Service Type</Text>
                            )}
                          </Box>
                          <ActionIcon
                            color="red"
                            variant="subtle"
                            onClick={(e) => {
                              e.stopPropagation();
                              updateDefault({
                                serviceTypeOverrides: formValues.serviceTypeOverrides.filter((_, i) => i !== index),
                              });
                            }}
                          >
                            <IconTrash size={16} />
                          </ActionIcon>
                        </Group>
                      </Accordion.Control>
                      <Accordion.Panel>
                        <Stack gap="md">
                          <Box>
                            <Text fw={500} size="sm" mb="xs">
                              Service Type
                            </Text>
                            <CodeableConceptInput
                              value={override.serviceType}
                              onChange={(value) => updateOverride(index, { serviceType: value ?? override.serviceType })}
                              name={`service-type-${index}`}
                              path="Schedule.extension.extension.serviceType"
                              placeholder="Select or enter service type"
                            />
                          </Box>
                          <AvailabilityFields
                            weekSchedule={override.weekSchedule}
                            setWeekSchedule={(ws) => updateOverride(index, { weekSchedule: ws })}
                            durationValue={override.durationValue}
                            durationUnit={override.durationUnit}
                            setDuration={(v, u) => updateOverride(index, { durationValue: v, durationUnit: u })}
                            bufferBefore={override.bufferBefore}
                            bufferAfter={override.bufferAfter}
                            setBufferBefore={(v) => updateOverride(index, { bufferBefore: v })}
                            setBufferAfter={(v) => updateOverride(index, { bufferAfter: v })}
                            alignmentInterval={override.alignmentInterval}
                            alignmentOffset={override.alignmentOffset}
                            setAlignmentInterval={(v) => updateOverride(index, { alignmentInterval: v })}
                            setAlignmentOffset={(v) => updateOverride(index, { alignmentOffset: v })}
                            bookingLimits={override.bookingLimits}
                            setBookingLimits={(limits) => updateOverride(index, { bookingLimits: limits })}
                            timezone={override.timezone}
                            setTimezone={(tz) => updateOverride(index, { timezone: tz })}
                          />
                        </Stack>
                      </Accordion.Panel>
                    </Accordion.Item>
                  ))}
                </Accordion>
              )}
            </Stack>
          </Tabs.Panel>

          {/* ====== BLOCK TIME ====== */}
          <Tabs.Panel value="block-time" pt="md">
            <Stack gap="lg">
              {/* ── Existing Blocked Times ── */}
              <Box>
                <Text fw={600} size="sm" mb={4}>
                  Current Blocks
                </Text>
                {loadingBlocks ? (
                  <Text size="sm" c="dimmed">Loading...</Text>
                ) : existingBlocks.length === 0 ? (
                  <Text size="xs" c="dimmed">No blocked times yet.</Text>
                ) : (() => {
                  const now = new Date();
                  const upcomingBlocks = existingBlocks.filter((s) => new Date(s.end) >= now);
                  const pastBlocks = existingBlocks.filter((s) => new Date(s.end) < now);

                  const dateFmt: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric' };
                  const timeFmt: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };

                  const renderBlockRow = (slot: WithId<Slot>, isPast: boolean): JSX.Element => {
                    const start = new Date(slot.start);
                    const end = new Date(slot.end);
                    const sameDay = start.toDateString() === end.toDateString();
                    const isAllDay = start.getHours() === 0 && start.getMinutes() === 0 &&
                      (end.getHours() === 23 || (end.getHours() === 0 && end.getMinutes() === 0));

                    let label: string;
                    if (isAllDay && sameDay) {
                      label = `${start.toLocaleDateString('en-US', dateFmt)} · All day`;
                    } else if (isAllDay) {
                      label = `${start.toLocaleDateString('en-US', dateFmt)} – ${end.toLocaleDateString('en-US', dateFmt)} · All day`;
                    } else if (sameDay) {
                      label = `${start.toLocaleDateString('en-US', dateFmt)} ${start.toLocaleTimeString('en-US', timeFmt)} – ${end.toLocaleTimeString('en-US', timeFmt)}`;
                    } else {
                      label = `${start.toLocaleDateString('en-US', dateFmt)} ${start.toLocaleTimeString('en-US', timeFmt)} – ${end.toLocaleDateString('en-US', dateFmt)} ${end.toLocaleTimeString('en-US', timeFmt)}`;
                    }

                    return (
                      <Group
                        key={slot.id}
                        gap="xs"
                        py={4}
                        px="xs"
                        style={{
                          borderRadius: 6,
                          background: isPast ? '#f8f9fa' : '#fff5f5',
                          opacity: isPast ? 0.6 : 1,
                        }}
                        justify="space-between"
                        wrap="nowrap"
                      >
                        <Group gap="xs" wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
                          <IconBan size={14} color={isPast ? '#868e96' : '#e03131'} style={{ flexShrink: 0 }} />
                          <Text size="xs" fw={500} truncate>
                            {label}
                          </Text>
                          {slot.comment && (
                            <Text size="xs" c="dimmed" truncate>
                              — {slot.comment}
                            </Text>
                          )}
                        </Group>
                        <ActionIcon
                          color="red"
                          variant="subtle"
                          size="xs"
                          onClick={() => handleDeleteBlock(slot)}
                          aria-label="Delete block"
                        >
                          <IconTrash size={14} />
                        </ActionIcon>
                      </Group>
                    );
                  };

                  return (
                    <Stack gap={4}>
                      {/* Upcoming blocks — always visible */}
                      {upcomingBlocks.length === 0 && pastBlocks.length > 0 && (
                        <Text size="xs" c="dimmed">No upcoming blocks.</Text>
                      )}
                      {upcomingBlocks.map((slot) => renderBlockRow(slot, false))}

                      {/* Past blocks — collapsed by default */}
                      {pastBlocks.length > 0 && (
                        <Box mt={upcomingBlocks.length > 0 ? 8 : 0}>
                          <Group justify="space-between" align="center">
                            <UnstyledButton
                              onClick={() => setShowPastBlocks((v) => !v)}
                              style={{ display: 'flex', alignItems: 'center', gap: 4 }}
                            >
                              {showPastBlocks ? (
                                <IconChevronDown size={14} color="#868e96" />
                              ) : (
                                <IconChevronRight size={14} color="#868e96" />
                              )}
                              <Text size="xs" c="dimmed">
                                {pastBlocks.length} past block{pastBlocks.length !== 1 ? 's' : ''}
                              </Text>
                            </UnstyledButton>
                            {showPastBlocks && (
                              <Button
                                size="compact-xs"
                                variant="subtle"
                                color="red"
                                onClick={handleClearPastBlocks}
                              >
                                Clear all past
                              </Button>
                            )}
                          </Group>
                          <Collapse in={showPastBlocks}>
                            <Stack gap={4} mt={4}>
                              {pastBlocks.map((slot) => renderBlockRow(slot, true))}
                            </Stack>
                          </Collapse>
                        </Box>
                      )}
                    </Stack>
                  );
                })()}
              </Box>

              <Divider />

              {/* ── Add Custom Block ── */}
              <Box>
                <Group justify="space-between" mb="sm">
                  <Box>
                    <Text fw={600} size="sm">
                      Add Block
                    </Text>
                    <Text size="xs" c="dimmed">
                      Vacation, errands, appointments
                    </Text>
                  </Box>
                  <Button
                    size="xs"
                    variant="light"
                    leftSection={<IconPlus size={14} />}
                    onClick={() => {
                      const todayStr = new Date().toISOString().substring(0, 10);
                      setBlockedTimes((prev) => [
                        ...prev,
                        {
                          allDay: true,
                          startDate: todayStr,
                          endDate: todayStr,
                          startTime: '14:00',
                          endTime: '15:00',
                          comment: '',
                        },
                      ]);
                    }}
                  >
                    New Block
                  </Button>
                </Group>

                <Stack gap="sm">
                  {blockedTimes.length === 0 && (
                    <Text size="xs" c="dimmed" ta="center" py="xs">
                      Click &quot;New Block&quot; to block off time for vacations, appointments, etc.
                    </Text>
                  )}
                  {blockedTimes.map((block, index) => {
                    const updateBlock = (patch: Partial<BlockedTime>): void => {
                      setBlockedTimes((prev) => {
                        const next = [...prev];
                        next[index] = { ...block, ...patch };
                        return next;
                      });
                    };

                    const hasDates = !!block.startDate && !!block.endDate;
                    const dateOrderOk = hasDates && block.endDate >= block.startDate;
                    // For same-day partial blocks, end time must be after start time.
                    // For multi-day partial blocks, overnight is fine (e.g. 8 PM → 5 AM next day).
                    const sameDay = block.startDate === block.endDate;
                    const timeOrderOk =
                      block.allDay ||
                      !block.startTime ||
                      !block.endTime ||
                      !sameDay ||
                      block.endTime > block.startTime;
                    const isValid = block.allDay
                      ? dateOrderOk
                      : dateOrderOk && !!block.startTime && !!block.endTime && timeOrderOk;

                    // Compute a human-readable reason when invalid
                    let validationHint = '';
                    if (hasDates && !dateOrderOk) {
                      validationHint = 'End date must be on or after start date';
                    } else if (!block.allDay && sameDay && block.startTime && block.endTime && !timeOrderOk) {
                      validationHint = 'End time must be after start time';
                    }

                    return (
                      <Card key={index} withBorder p="sm" radius="md" style={{ position: 'relative' }}>
                        <ActionIcon
                          color="red"
                          variant="subtle"
                          size="sm"
                          style={{ position: 'absolute', top: 8, right: 8 }}
                          onClick={() => setBlockedTimes((prev) => prev.filter((_, i) => i !== index))}
                          aria-label="Remove block"
                        >
                          <IconTrash size={16} />
                        </ActionIcon>

                        <Stack gap="xs">
                          <Group gap="sm" align="flex-end">
                            <TextInput
                              label="Start"
                              type="date"
                              value={block.startDate}
                              onChange={(e) => {
                                const v = e.target.value;
                                // Auto-set end date to match start when start changes
                                if (!block.endDate || block.endDate < v) {
                                  updateBlock({ startDate: v, endDate: v });
                                } else {
                                  updateBlock({ startDate: v });
                                }
                              }}
                              size="xs"
                              style={{ flex: 1 }}
                              required
                            />
                            <TextInput
                              label="End"
                              type="date"
                              value={block.endDate}
                              onChange={(e) => updateBlock({ endDate: e.target.value })}
                              size="xs"
                              style={{ flex: 1 }}
                              required
                            />
                            <Switch
                              label="All day"
                              checked={block.allDay}
                              onChange={(e) => updateBlock({ allDay: e.currentTarget.checked })}
                              size="xs"
                              pb={4}
                            />
                          </Group>

                          {!block.allDay && (
                            <Group gap="sm">
                              <TextInput
                                label="From"
                                type="time"
                                value={block.startTime}
                                onChange={(e) => {
                                  const newStart = e.target.value;
                                  const [hStr, mStr] = newStart.split(':');
                                  const h = parseInt(hStr, 10);
                                  const m = parseInt(mStr, 10);
                                  if (!isNaN(h) && !isNaN(m)) {
                                    const endH = (h + 1) % 24;
                                    const newEnd = `${String(endH).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
                                    updateBlock({ startTime: newStart, endTime: newEnd });
                                  } else {
                                    updateBlock({ startTime: newStart });
                                  }
                                }}
                                size="xs"
                                style={{ width: 110 }}
                                required
                              />
                              <TextInput
                                label="To"
                                type="time"
                                value={block.endTime}
                                onChange={(e) => updateBlock({ endTime: e.target.value })}
                                size="xs"
                                style={{ width: 110 }}
                                required
                              />
                            </Group>
                          )}

                          <Group gap="sm" align="flex-end">
                            <TextInput
                              placeholder="Reason (optional)"
                              value={block.comment}
                              onChange={(e) => updateBlock({ comment: e.target.value })}
                              size="xs"
                              style={{ flex: 1 }}
                            />
                            <Tooltip
                              label={validationHint}
                              disabled={!validationHint}
                              position="top"
                              withArrow
                            >
                              <Button
                                size="xs"
                                color="red"
                                leftSection={<IconBan size={14} />}
                                loading={blockSaving}
                                disabled={!isValid}
                                onClick={() => handleBlockTime(block)}
                                data-disabled={!isValid || undefined}
                                styles={!isValid ? { root: { pointerEvents: 'all' } } : undefined}
                              >
                                Block
                              </Button>
                            </Tooltip>
                          </Group>
                          {validationHint && (
                            <Text size="xs" c="red" mt={-2}>
                              {validationHint}
                            </Text>
                          )}
                        </Stack>
                      </Card>
                    );
                  })}
                </Stack>
              </Box>

              <Divider />

              {/* ── Federal Holidays ── */}
              <Box>
                <Text fw={600} size="sm" mb={4}>
                  Federal Holidays
                </Text>
                <Text size="xs" c="dimmed" mb="sm">
                  Quickly block US federal holidays you observe.
                </Text>
                <Card withBorder p="sm" radius="md">
                  {unblockedHolidays.length === 0 && blockedHolidayNames.length > 0 ? (
                    <Text size="sm" c="dimmed" ta="center" py="xs">
                      All upcoming holidays are already blocked.
                    </Text>
                  ) : unblockedHolidays.length === 0 ? (
                    <Text size="sm" c="dimmed" ta="center" py="xs">
                      No upcoming holidays.
                    </Text>
                  ) : (
                    <>
                      <Checkbox.Group value={selectedHolidays} onChange={setSelectedHolidays}>
                        <Stack gap={6}>
                          {unblockedHolidays.map((h) => (
                            <Checkbox
                              key={h.date}
                              value={h.date}
                              label={
                                <Group gap="xs">
                                  <Text size="sm">{h.name}</Text>
                                  <Text size="xs" c="dimmed">
                                    {new Date(h.date + 'T12:00:00').toLocaleDateString('en-US', {
                                      weekday: 'short',
                                      month: 'short',
                                      day: 'numeric',
                                    })}
                                  </Text>
                                </Group>
                              }
                              size="xs"
                            />
                          ))}
                        </Stack>
                      </Checkbox.Group>
                      <Group justify="space-between" mt="sm">
                        <Group gap="xs">
                          <Button
                            size="compact-xs"
                            variant="subtle"
                            onClick={() => setSelectedHolidays(unblockedHolidays.map((h) => h.date))}
                          >
                            Select all
                          </Button>
                          <Button size="compact-xs" variant="subtle" onClick={() => setSelectedHolidays([])}>
                            Clear
                          </Button>
                        </Group>
                        <Button
                          size="xs"
                          color="red"
                          leftSection={<IconBan size={14} />}
                          loading={blockSaving}
                          disabled={selectedHolidays.length === 0}
                          onClick={handleBlockHolidays}
                        >
                          Block Holidays
                        </Button>
                      </Group>
                    </>
                  )}

                  {/* Show already-blocked holidays */}
                  {blockedHolidayNames.length > 0 && (
                    <Box mt="sm" pt="sm" style={{ borderTop: '1px solid #e9ecef' }}>
                      <Text size="xs" c="dimmed" mb={4}>
                        Already blocked:
                      </Text>
                      <Group gap={6}>
                        {blockedHolidayNames.map((h) => (
                          <Badge key={h.date} size="sm" variant="light" color="gray">
                            {h.name}
                          </Badge>
                        ))}
                      </Group>
                    </Box>
                  )}
                </Card>
              </Box>
            </Stack>
          </Tabs.Panel>
        </Tabs>

        {activeTab !== 'block-time' && (
          <Group justify="flex-end" mt="xl" pt="md" style={{ borderTop: '1px solid #dee2e6' }}>
            <Button variant="subtle" onClick={onClose} disabled={isLoading}>
              Cancel
            </Button>
            <Button type="submit" loading={isLoading} leftSection={<IconSettings size={16} />}>
              Save Availability
            </Button>
          </Group>
        )}
      </form>
    </Modal>
  );
}
