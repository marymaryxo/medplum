// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Box, Button, Center, Drawer, Group, Loader, Modal, Stack, Text, TextInput, Title } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import {
  createReference,
  EMPTY,
  isDefined,
  formatDateTime,
  getExtensionValue,
  getReferenceString,
} from '@medplum/core';
import type { WithId } from '@medplum/core';
import type { Appointment, Bundle, CodeableConcept, Practitioner, Schedule, Slot } from '@medplum/fhirtypes';
import { CodeableConceptDisplay, useMedplum, useMedplumProfile } from '@medplum/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import type { SlotInfo } from 'react-big-calendar';
import { useNavigate } from 'react-router';
import { v4 as uuidv4 } from 'uuid';
import { AppointmentDetails } from '../../components/schedule/AppointmentDetails';
import { CreateVisit } from '../../components/schedule/CreateVisit';
import { SetAvailabilityModal } from '../../components/schedule/SetAvailabilityModal';
import {
  cancelRecurrenceSeries,
  getRecurrenceSeriesId,
  updateEncounterStatus,
} from '../../utils/encounter';
import { showErrorNotification } from '../../utils/notifications';
import { Calendar } from '../../components/Calendar';
import type { AvailabilityRange } from '../../components/Calendar';
import { mergeOverlappingSlots, rangesOverlap } from '../../utils/slots';
import type { Range } from '../../types/scheduling';
import { showNotification } from '@mantine/notifications';
import { IconBan, IconCalendarPlus, IconChevronRight, IconCalendar, IconX } from '@tabler/icons-react';
import classes from './SchedulePage.module.css';
import { useSchedulingStartsAt } from '../../hooks/useSchedulingStartsAt';
import { SchedulingTransientIdentifier } from '../../utils/scheduling';

type ScheduleFindPaneProps = {
  schedule: WithId<Schedule>;
  range: Range;
  onChange: (slots: Slot[]) => void;
  onSelectSlot: (slot: Slot) => void;
  slots: Slot[] | undefined;
};

const SchedulingParametersURI = 'https://medplum.com/fhir/StructureDefinition/SchedulingParameters';

function parseSchedulingParameters(schedule: Schedule): (CodeableConcept | undefined)[] {
  const extensions = schedule?.extension?.filter((ext) => ext.url === SchedulingParametersURI) ?? [];
  const serviceTypes = extensions.map((ext) => getExtensionValue(ext, 'serviceType') as CodeableConcept | undefined);
  return serviceTypes;
}

// ---------------------------------------------------------------------------
// Generate visual availability slots from SchedulingParameters
// ---------------------------------------------------------------------------

const DAY_OF_WEEK_MAP: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

/**
 * Reads the default SchedulingParameters extension from a Schedule and, for
 * every day in `range` that matches the configured days-of-week, generates a
 * virtual `Slot` with `status: 'free'` for each configured time-window.
 *
 * These virtual slots have no `id` — they are purely for visual display on the
 * calendar and are not persisted.
 */
function generateAvailabilitySlots(schedule: Schedule, range: Range): Slot[] {
  const extensions = schedule.extension?.filter((ext) => ext.url === SchedulingParametersURI) ?? [];

  // Use only the default extension (no serviceType)
  const defaultExt = extensions.find((ext) => {
    const st = getExtensionValue(ext, 'serviceType') as CodeableConcept | undefined;
    return !st;
  });

  if (!defaultExt) {
    return [];
  }

  // There can be multiple availability entries (one per distinct duration).
  const availabilities =
    defaultExt.extension?.filter((sub) => sub.url === 'availability') ?? [];

  if (availabilities.length === 0) {
    return [];
  }

  // Collect { daysOfWeek[], timeOfDay[], durationHours } from each availability
  interface AvailEntry {
    days: Set<number>;
    windows: { startHour: number; startMin: number; durationHours: number }[];
  }

  const entries: AvailEntry[] = availabilities.map((avail) => {
    const repeat = (avail.valueTiming as { repeat?: Record<string, unknown> })?.repeat as
      | {
          dayOfWeek?: string[];
          timeOfDay?: string[];
          duration?: number;
          durationUnit?: string;
        }
      | undefined;

    const dayStrings = repeat?.dayOfWeek ?? [];
    const days = new Set(dayStrings.map((d) => DAY_OF_WEEK_MAP[d] ?? -1).filter((n) => n >= 0));

    const dur = repeat?.duration ?? 8;
    const durUnit = repeat?.durationUnit ?? 'h';
    const durationHours = durUnit === 'h' ? dur : dur / 60;

    const windows = (repeat?.timeOfDay ?? ['09:00:00']).map((time) => {
      const parts = time.split(':').map(Number);
      return { startHour: parts[0] ?? 9, startMin: parts[1] ?? 0, durationHours };
    });

    return { days, windows };
  });

  // Iterate over each day in the range
  const slots: Slot[] = [];
  const current = new Date(range.start);
  current.setHours(0, 0, 0, 0);
  const end = new Date(range.end);
  end.setHours(23, 59, 59, 999);

  const scheduleRef = schedule.id ? createReference(schedule) : undefined;

  while (current <= end) {
    const dow = current.getDay();
    for (const entry of entries) {
      if (!entry.days.has(dow)) {
        continue;
      }
      for (const w of entry.windows) {
        const slotStart = new Date(current);
        slotStart.setHours(w.startHour, w.startMin, 0, 0);

        const slotEnd = new Date(slotStart.getTime() + w.durationHours * 60 * 60 * 1000);

        slots.push({
          resourceType: 'Slot',
          schedule: scheduleRef ?? { reference: '' },
          status: 'free',
          start: slotStart.toISOString(),
          end: slotEnd.toISOString(),
        });
      }
    }
    current.setDate(current.getDate() + 1);
  }

  return slots;
}

// Allows selection of a ServiceType found in the schedule's
// SchedulingParameters extensions, and runs a `$find` operation to look for
// upcoming slots that can be used to book an Appointment of that type.
//
// See https://www.medplum.com/docs/scheduling/defining-availability for details.
export function ScheduleFindPane(props: ScheduleFindPaneProps): JSX.Element {
  const { schedule, onChange, range } = props;
  const serviceTypes = useMemo(
    () =>
      parseSchedulingParameters(schedule).map((codeableConcept) => ({
        codeableConcept,
        id: uuidv4(),
      })),
    [schedule]
  );

  const medplum = useMedplum();

  // null: no selection made
  // undefined: "wildcard" availability selected
  // Coding: a specific service type was selected
  const [serviceType, setServiceType] = useState<CodeableConcept | undefined | null>(
    // If there is exactly one option, select it immediately instead of forcing user
    // to select it
    serviceTypes.length === 1 ? serviceTypes[0].codeableConcept : null
  );

  // Ensure that we are searching for slots in the future by at least 30 minutes.
  const earliestSchedulable = useSchedulingStartsAt({ minimumNoticeMinutes: 30 });
  const searchStart = range.start < earliestSchedulable ? earliestSchedulable : range.start;
  const searchEnd = searchStart < range.end ? range.end : new Date(searchStart.getTime() + 1000 * 60 * 60 * 24 * 7);

  const start = searchStart.toISOString();
  const end = searchEnd.toISOString();

  useEffect(() => {
    if (!schedule || serviceType === null) {
      return () => {};
    }
    const controller = new AbortController();
    const signal = controller.signal;
    const params = new URLSearchParams({ start, end });
    if (serviceType) {
      serviceType.coding?.forEach((coding) => {
        params.append('service-type', `${coding.system}|${coding.code}`);
      });
    }
    medplum
      .get<Bundle<Slot>>(`fhir/R4/Schedule/${schedule.id}/$find?${params}`, { signal })
      .then((bundle) => {
        if (!signal.aborted) {
          if (bundle.entry) {
            bundle.entry.forEach((entry) => entry.resource && SchedulingTransientIdentifier.set(entry.resource));
            onChange(bundle.entry.map((entry) => entry.resource).filter(isDefined));
          } else {
            onChange([]);
          }
        }
      })
      .catch((error) => {
        if (!signal.aborted) {
          showErrorNotification(error);
        }
      });
    return () => {
      controller.abort();
    };
  }, [medplum, schedule, serviceType, start, end, onChange]);

  const handleDismiss = useCallback(() => {
    setServiceType(null);
    onChange([]);
  }, [onChange]);

  if (serviceType !== null) {
    return (
      <Stack gap="sm" justify="flex-start">
        <Title order={4}>
          <Group justify="space-between">
            <span>{serviceType ? <CodeableConceptDisplay value={serviceType} /> : 'Event'}</span>
            {serviceTypes.length > 1 && (
              <Button variant="subtle" onClick={handleDismiss} aria-label="Clear selection">
                <IconX size={20} />
              </Button>
            )}
          </Group>
        </Title>
        {(props.slots ?? EMPTY).map((slot) => (
          <Button
            key={SchedulingTransientIdentifier.get(slot)}
            variant="outline"
            color="gray.3"
            styles={(theme) => ({ label: { fontWeight: 'normal', color: theme.colors.gray[9] } })}
            onClick={() => props.onSelectSlot(slot)}
          >
            {formatDateTime(slot.start)}
          </Button>
        ))}
      </Stack>
    );
  }

  return (
    <Stack gap="sm" justify="flex-start">
      <Title order={4}>Schedule&hellip;</Title>
      {serviceTypes.map((st) => (
        <Button
          key={st.id}
          fullWidth
          variant="outline"
          rightSection={<IconChevronRight size={12} />}
          justify="space-between"
          onClick={() => setServiceType(st.codeableConcept)}
        >
          {st.codeableConcept ? <CodeableConceptDisplay value={st.codeableConcept} /> : 'Other'}
        </Button>
      ))}
    </Stack>
  );
}

/**
 * Schedule page that displays the practitioner's schedule.
 * Allows the practitioner to create/update slots and create appointments.
 * @returns A React component that displays the schedule page.
 */
export function SchedulePage(): JSX.Element | null {
  const navigate = useNavigate();
  const medplum = useMedplum();
  const profile = useMedplumProfile() as Practitioner;
  const [createAppointmentOpened, createAppointmentHandlers] = useDisclosure(false);
  const [appointmentDetailsOpened, appointmentDetailsHandlers] = useDisclosure(false);
  const [setAvailabilityOpened, setAvailabilityHandlers] = useDisclosure(false);
  const [slotChoiceOpened, slotChoiceHandlers] = useDisclosure(false);
  const [pendingSlotInfo, setPendingSlotInfo] = useState<SlotInfo | null>(null);
  const [blockReason, setBlockReason] = useState('');
  const [blockSaving, setBlockSaving] = useState(false);
  const [showBlockForm, setShowBlockForm] = useState(false);
  const [schedule, setSchedule] = useState<WithId<Schedule> | undefined>();
  const [range, setRange] = useState<Range | undefined>(undefined);
  const [slots, setSlots] = useState<Slot[] | undefined>(undefined);
  const [appointments, setAppointments] = useState<Appointment[] | undefined>(undefined);
  const [findSlots, setFindSlots] = useState<Slot[] | undefined>(undefined);

  const [appointmentSlot, setAppointmentSlot] = useState<Range>();
  const [appointmentDetails, setAppointmentDetails] = useState<Appointment | undefined>(undefined);
  const [appointmentsRefreshTrigger, setAppointmentsRefreshTrigger] = useState(0);

  useEffect(() => {
    if (medplum.isLoading() || !profile) {
      return;
    }

    // Search for a Schedule associated with the logged user,
    // create one if it doesn't exist
    medplum
      .searchOne('Schedule', { actor: getReferenceString(profile) })
      .then((foundSchedule) => {
        if (foundSchedule) {
          setSchedule(foundSchedule);
        } else {
          medplum
            .createResource({
              resourceType: 'Schedule',
              actor: [createReference(profile)],
              active: true,
            })
            .then(setSchedule)
            .catch(showErrorNotification);
        }
      })
      .catch(showErrorNotification);
  }, [medplum, profile]);

  // Refetch slots (used on mount/range change and when availability modal closes)
  const refreshSlots = useCallback(() => {
    if (!schedule || !range) return;
    medplum
      .searchResources('Slot', [
        ['_count', '1000'],
        ['schedule', getReferenceString(schedule)],
        ['start', `ge${range.start.toISOString()}`],
        ['start', `le${range.end.toISOString()}`],
        ['status', 'free,busy-unavailable'],
      ])
      .then((rawSlots) => setSlots(mergeOverlappingSlots(rawSlots)))
      .catch((error: unknown) => showErrorNotification(error));
  }, [medplum, schedule, range]);

  useEffect(() => {
    refreshSlots();
  }, [refreshSlots]);

  // Find appointments visible in the current range
  useEffect(() => {
    if (!profile || !range) {
      return () => {};
    }
    let active = true;

    medplum
      .searchResources('Appointment', [
        ['_count', '1000'],
        ['actor', getReferenceString(profile as WithId<Practitioner>)],
        ['date', `ge${range.start.toISOString()}`],
        ['date', `le${range.end.toISOString()}`],
      ])
      .then((appointments) => active && setAppointments(appointments))
      .catch((error: unknown) => active && showErrorNotification(error));

    return () => {
      active = false;
    };
  }, [medplum, profile, range, appointmentsRefreshTrigger]);

  // When a date/time interval is selected, open slot choice modal (New appointment or Block time).
  // Single click -> 60 min; drag selection -> use actual range.
  // Click on all-day row (top) -> entire day, go straight to block form (like Google Calendar).
  const DEFAULT_APPT_MINUTES = 60;
  const handleSelectInterval = useCallback((slot: SlotInfo) => {
    const start = new Date(slot.start);
    const end =
      slot.action === 'select'
        ? new Date(slot.end)
        : new Date(slot.start.getTime() + DEFAULT_APPT_MINUTES * 60 * 1000);

    // All-day row / top-area: treat as entire day(s) (like Google Calendar).
    // - True all-day row: full-day span (23+ hrs from midnight)
    // - Single-day top click: first rows (12am–2am), short duration
    // - Multi-day top drag: spans 24+ hrs and starts in early morning (top area)
    const durationHours = (end.getTime() - start.getTime()) / (60 * 60 * 1000);
    const isFullDaySpan = durationHours >= 23 && start.getHours() === 0 && start.getMinutes() === 0;
    const isTopAreaClick = start.getHours() < 2 && durationHours <= 2;
    const isMultiDayTopDrag = durationHours >= 24 && start.getHours() < 4;
    const isAllDayClick = isFullDaySpan || isTopAreaClick || isMultiDayTopDrag;

    if (isAllDayClick) {
      const dayStart = new Date(start);
      dayStart.setHours(0, 0, 0, 0);
      let dayEnd: Date;
      if (durationHours >= 24) {
        // Multi-day drag: end is midnight of day after last selected day
        dayEnd = new Date(end);
        if (dayEnd.getHours() === 0 && dayEnd.getMinutes() === 0) {
          dayEnd.setDate(dayEnd.getDate() - 1);
        }
        dayEnd.setHours(23, 59, 59, 999);
      } else {
        // Single day
        dayEnd = new Date(dayStart);
        dayEnd.setHours(23, 59, 59, 999);
      }
      setPendingSlotInfo({ ...slot, start: dayStart, end: dayEnd });
      setShowBlockForm(true);
    } else {
      setPendingSlotInfo({ ...slot, start, end });
      setShowBlockForm(false);
    }
    setBlockReason('');
    slotChoiceHandlers.open();
  }, []);

  const handleNewAppointmentFromChoice = useCallback(() => {
    if (!pendingSlotInfo) return;

    const slotStart = pendingSlotInfo.start;
    const slotEnd = pendingSlotInfo.end;

    // Prevent appointment over existing block (FHIR: busy-unavailable is not bookable)
    const blockedSlots = (slots ?? []).filter(
      (s) => s.id && s.status === 'busy-unavailable' && !SchedulingTransientIdentifier.get(s)
    );
    const overlappingBlock = blockedSlots.find((s) =>
      rangesOverlap(slotStart, slotEnd, new Date(s.start), new Date(s.end))
    );
    if (overlappingBlock) {
      showNotification({
        color: 'red',
        message: 'This time is blocked. Choose another time or remove the block first.',
      });
      return;
    }

    // Prevent overlapping appointments
    const overlappingAppointment = (appointments ?? []).find(
      (apt) =>
        apt.start &&
        apt.end &&
        apt.status !== 'cancelled' &&
        rangesOverlap(slotStart, slotEnd, new Date(apt.start), new Date(apt.end))
    );
    if (overlappingAppointment) {
      showNotification({
        color: 'red',
        message: 'This time overlaps with an existing appointment. Choose another time.',
      });
      return;
    }

    slotChoiceHandlers.close();
    setShowBlockForm(false);
    setAppointmentSlot({ start: pendingSlotInfo.start, end: pendingSlotInfo.end });
    createAppointmentHandlers.open();
  }, [pendingSlotInfo, slotChoiceHandlers, createAppointmentHandlers, slots, appointments]);

  const handleBlockFromCalendar = useCallback(async () => {
    if (!pendingSlotInfo || !schedule) return;

    // Prevent block over existing appointment (best practice)
    const blockStart = pendingSlotInfo.start;
    const blockEnd = pendingSlotInfo.end;
    const overlappingAppointment = (appointments ?? []).find(
      (apt) =>
        apt.start &&
        apt.end &&
        apt.status !== 'cancelled' &&
        rangesOverlap(blockStart, blockEnd, new Date(apt.start), new Date(apt.end))
    );
    if (overlappingAppointment) {
      showNotification({
        color: 'red',
        message: "You have an appointment during this time. Move or cancel it first to block.",
      });
      return;
    }

    setBlockSaving(true);
    try {
      await medplum.createResource<Slot>({
        resourceType: 'Slot',
        schedule: createReference(schedule),
        status: 'busy-unavailable',
        start: pendingSlotInfo.start.toISOString(),
        end: pendingSlotInfo.end.toISOString(),
        comment: blockReason.trim() || undefined,
      });
      medplum.invalidateSearches('Slot');
      refreshSlots();
      slotChoiceHandlers.close();
      setShowBlockForm(false);
      setPendingSlotInfo(null);
      setBlockReason('');
      showNotification({ message: 'Time blocked successfully' });
    } catch (error) {
      showErrorNotification(error);
    } finally {
      setBlockSaving(false);
    }
  }, [pendingSlotInfo, schedule, blockReason, medplum, refreshSlots, slotChoiceHandlers, appointments]);

  const bookSlot = useCallback(
    async (slot: Slot) => {
      const data = await medplum.post<Bundle<Appointment | Slot>>(medplum.fhirUrl('Appointment', '$book'), {
        resourceType: 'Parameters',
        parameter: [{ name: 'slot', resource: slot }],
      });
      medplum.invalidateSearches('Appointment');
      medplum.invalidateSearches('Slot');

      // Remove the $find result we acted on from our state
      const id = SchedulingTransientIdentifier.get(slot);
      setFindSlots((slots) => (slots ?? EMPTY).filter((slot) => SchedulingTransientIdentifier.get(slot) !== id));

      // Add the $book response to our state
      const resources = data.entry?.map((entry) => entry.resource).filter(isDefined) ?? EMPTY;
      const slots = resources
        .filter((obj: Slot | Appointment): obj is Slot => obj.resourceType === 'Slot')
        .filter((slot) => slot.status !== 'busy');
      const appointments = resources.filter(
        (obj: Slot | Appointment): obj is Appointment => obj.resourceType === 'Appointment'
      );
      setAppointments((state) => appointments.concat(state ?? EMPTY));
      setSlots((state) => slots.concat(state ?? EMPTY));

      // Open the appointment details drawer for the resource we just created
      const firstAppointment = appointments[0];
      if (firstAppointment) {
        setAppointmentDetails(firstAppointment);
        appointmentDetailsHandlers.open();
      }
    },
    [medplum, appointmentDetailsHandlers]
  );

  const [bookLoading, setBookLoading] = useState(false);

  const handleSelectSlot = useCallback(
    (slot: Slot) => {
      // If selecting a slot from "$find", run it through "$book" to create an
      // appointment and slots
      if (SchedulingTransientIdentifier.get(slot)) {
        setBookLoading(true);
        bookSlot(slot)
          .catch(showErrorNotification)
          .finally(() => setBookLoading(false));
        return;
      }

      // When a "busy-unavailable" slot with an id is clicked, offer to delete it
      if (slot.status === 'busy-unavailable' && slot.id) {
        const start = new Date(slot.start);
        const end = new Date(slot.end);
        const label = slot.comment
          ? `"${slot.comment}" (${start.toLocaleString()} – ${end.toLocaleString()})`
          : `${start.toLocaleString()} – ${end.toLocaleString()}`;
        if (window.confirm(`Remove this blocked time?\n\n${label}`)) {
          medplum
            .deleteResource('Slot', slot.id)
            .then(() => {
              setSlots((prev) => (prev ?? []).filter((s) => s.id !== slot.id));
              medplum.invalidateSearches('Slot');
            })
            .catch(showErrorNotification);
        }
        return;
      }

      // When a "free" slot is selected, open the create appointment modal (60 min).
      if (slot.status === 'free') {
        const start = new Date(slot.start);
        const end = new Date(start.getTime() + 60 * 60 * 1000);

        // Prevent overlapping appointments
        const overlappingAppointment = (appointments ?? []).find(
          (apt) =>
            apt.start &&
            apt.end &&
            apt.status !== 'cancelled' &&
            rangesOverlap(start, end, new Date(apt.start), new Date(apt.end))
        );
        if (overlappingAppointment) {
          showNotification({
            color: 'red',
            message: 'This time overlaps with an existing appointment. Choose another time.',
          });
          return;
        }

        createAppointmentHandlers.open();
        setAppointmentSlot({ start, end });
      }
    },
    [createAppointmentHandlers, bookSlot, medplum, appointments]
  );

  // When an appointment is selected, navigate to the detail page
  const handleSelectAppointment = useCallback(
    async (appointment: Appointment) => {
      const reference = getReferenceString(appointment);
      if (!reference) {
        showErrorNotification("Can't navigate to unsaved appointment");
        return;
      }

      try {
        const encounters = await medplum.searchResources('Encounter', [
          ['appointment', reference],
          ['_count', '1'],
        ]);

        if (encounters.length === 0) {
          setAppointmentDetails(appointment);
          appointmentDetailsHandlers.open();
          return;
        }

        const patient = encounters?.[0]?.subject;
        if (patient?.reference) {
          await navigate(`/${patient.reference}/Encounter/${encounters?.[0]?.id}`);
        }
      } catch (error) {
        showErrorNotification(error);
      }
    },
    [medplum, navigate, appointmentDetailsHandlers]
  );

  const [height, setHeight] = useState(window.innerHeight - 60);

  useEffect(() => {
    const onResize = (): void => setHeight(window.innerHeight - 60);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const allServiceTypes = useMemo(() => schedule && parseSchedulingParameters(schedule), [schedule]);
  // Only show the find-pane sidebar when there are actual named service types (not just wildcard/undefined)
  const serviceTypes = useMemo(
    () => allServiceTypes?.filter((st): st is CodeableConcept => st !== undefined),
    [allServiceTypes]
  );

  // Generate visual availability slots from the Schedule's SchedulingParameters
  const availabilitySlots = useMemo(
    () => (schedule && range ? generateAvailabilitySlots(schedule, range) : []),
    [schedule, range]
  );

  // Convert availability slots to AvailabilityRange[] for the calendar's gray-out logic
  const availabilityRanges: AvailabilityRange[] = useMemo(
    () => availabilitySlots.map((s) => ({ start: new Date(s.start), end: new Date(s.end) })),
    [availabilitySlots]
  );

  const handleAppointmentUpdate = useCallback((updated: Appointment) => {
    setAppointments((state) => (state ?? []).map((existing) => (existing.id === updated.id ? updated : existing)));
    setAppointmentDetails((existing) => (existing?.id === updated.id ? updated : existing));
  }, []);

  const handleCancelAppointment = useCallback(
    async (appointment: Appointment) => {
      if (!appointment.id) return;
      try {
        const encounters = await medplum.searchResources('Encounter', {
          appointment: getReferenceString(appointment as Appointment & { id: string }),
        });
        const encounter = encounters[0];
        if (encounter) {
          await updateEncounterStatus(
            medplum,
            encounter,
            appointment as Appointment & { id: string },
            'cancelled'
          );
        } else {
          await medplum.updateResource({ ...appointment, status: 'cancelled' });
        }
        setAppointments((state) =>
          (state ?? []).map((a) => (a.id === appointment.id ? { ...a, status: 'cancelled' as const } : a))
        );
        setAppointmentDetails((a) => (a?.id === appointment.id ? { ...a, status: 'cancelled' as const } : a));
        showNotification({ message: 'Appointment cancelled' });
      } catch (err) {
        showErrorNotification(err);
      }
    },
    [medplum]
  );

  const handleCancelSeries = useCallback(
    async (appointment: Appointment) => {
      const seriesId = getRecurrenceSeriesId(appointment);
      if (!seriesId) return;
      try {
        const { cancelledCount } = await cancelRecurrenceSeries(medplum, seriesId);
        setAppointmentsRefreshTrigger((t) => t + 1);
        showNotification({
          message: `Cancelled ${cancelledCount} appointment${cancelledCount === 1 ? '' : 's'} in the series.`,
        });
      } catch (err) {
        showErrorNotification(err);
      }
    },
    [medplum]
  );

  const handleRescheduleAppointment = useCallback(
    async (appointment: Appointment, start: Date, end: Date) => {
      if (!appointment.id) return;
      try {
        const updated = await medplum.updateResource({
          ...appointment,
          start: start.toISOString(),
          end: end.toISOString(),
        });
        setAppointments((state) =>
          (state ?? []).map((a) => (a.id === appointment.id ? updated : a))
        );
        setAppointmentDetails((a) => (a?.id === appointment.id ? updated : a));
        showNotification({ message: 'Appointment rescheduled' });
      } catch (err) {
        showErrorNotification(err);
      }
    },
    [medplum]
  );

  return (
    <Box pos="relative" bg="white" p="md" style={{ height }}>
      <Group justify="space-between" mb="md">
        <Title order={2}>Schedule</Title>
        {schedule && (
          <Button
            size="md"
            leftSection={<IconCalendar size={18} />}
            onClick={setAvailabilityHandlers.open}
            variant="light"
          >
            Set Availability
          </Button>
        )}
      </Group>
      <div className={classes.container}>
        <div className={classes.calendar}>
          <Calendar
            style={{ height: height - 100 }}
            onSelectInterval={handleSelectInterval}
            onSelectAppointment={handleSelectAppointment}
            onSelectSlot={handleSelectSlot}
            onCancelAppointment={handleCancelAppointment}
            onCancelSeries={handleCancelSeries}
            onRescheduleAppointment={handleRescheduleAppointment}
            slots={[...(slots ?? []), ...(findSlots ?? [])]}
            appointments={appointments ?? []}
            availabilityRanges={availabilityRanges}
            onRangeChange={setRange}
          />
        </div>

        {!!serviceTypes?.length && schedule && range && (
          <Stack gap="md" justify="space-between" className={classes.findPane}>
            <ScheduleFindPane
              key={schedule.id}
              schedule={schedule}
              range={range}
              onChange={setFindSlots}
              onSelectSlot={(slot) => handleSelectSlot(slot)}
              slots={findSlots}
            />
            {bookLoading && (
              <Center>
                <Loader />
              </Center>
            )}
          </Stack>
        )}
      </div>

      {/* Slot choice modal: New appointment or Block time */}
      <Modal
        opened={slotChoiceOpened}
        onClose={() => {
          slotChoiceHandlers.close();
          setShowBlockForm(false);
        }}
        title={showBlockForm ? 'Block time' : 'What would you like to do?'}
        centered
      >
        {pendingSlotInfo &&
          (showBlockForm ? (
            <Stack gap="md">
              <Text size="md" c="dimmed">
                {(() => {
                  const start = pendingSlotInfo.start;
                  const end = pendingSlotInfo.end;
                  const isAllDay =
                    start.getHours() === 0 &&
                    start.getMinutes() === 0 &&
                    (end.getHours() === 23 || (end.getHours() === 0 && end.getDate() > start.getDate()));
                  const dateFmt = { weekday: 'short', month: 'short', day: 'numeric' } as const;
                  if (isAllDay) {
                    const sameDay = start.toDateString() === end.toDateString();
                    return sameDay
                      ? `${start.toLocaleDateString('en-US', dateFmt)} · All day`
                      : `${start.toLocaleDateString('en-US', dateFmt)} – ${end.toLocaleDateString('en-US', dateFmt)} · All day`;
                  }
                  return `${start.toLocaleString('en-US', {
                    weekday: 'short',
                    month: 'short',
                    day: 'numeric',
                    hour: 'numeric',
                    minute: '2-digit',
                  })} – ${end.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
                })()}
              </Text>
              <TextInput
                label="Reason (optional)"
                placeholder="e.g. Vacation, doctor's appointment"
                value={blockReason}
                onChange={(e) => setBlockReason(e.target.value)}
                size="md"
              />
              <Group justify="flex-end" gap="sm">
                <Button variant="subtle" size="md" onClick={() => setShowBlockForm(false)}>
                  Back
                </Button>
                <Button
                  color="red"
                  size="md"
                  leftSection={<IconBan size={18} />}
                  loading={blockSaving}
                  onClick={handleBlockFromCalendar}
                >
                  Block
                </Button>
              </Group>
            </Stack>
          ) : (
            <Stack gap="md">
              <Text size="md" c="dimmed">
                {pendingSlotInfo.start.toLocaleString('en-US', {
                  weekday: 'short',
                  month: 'short',
                  day: 'numeric',
                  hour: 'numeric',
                  minute: '2-digit',
                })}{' '}
                –{' '}
                {pendingSlotInfo.end.toLocaleString('en-US', {
                  hour: 'numeric',
                  minute: '2-digit',
                })}
              </Text>
              <Group grow>
                <Button
                  size="md"
                  leftSection={<IconCalendarPlus size={18} />}
                  variant="light"
                  onClick={handleNewAppointmentFromChoice}
                >
                  New appointment
                </Button>
                <Button
                  size="md"
                  leftSection={<IconBan size={18} />}
                  color="red"
                  variant="light"
                  onClick={() => setShowBlockForm(true)}
                >
                  Block time
                </Button>
              </Group>
            </Stack>
          ))}
      </Modal>

      {/* Modals */}
      <Drawer
        opened={createAppointmentOpened}
        onClose={createAppointmentHandlers.close}
        title="New Calendar Event"
        position="right"
        h="100%"
      >
        <CreateVisit
          appointmentSlot={appointmentSlot}
          blockedSlots={(slots ?? []).filter(
            (s) => s.id && s.status === 'busy-unavailable' && !SchedulingTransientIdentifier.get(s)
          )}
          existingAppointments={(appointments ?? []).filter((a) => a.status !== 'cancelled')}
        />
      </Drawer>
      <Drawer
        opened={appointmentDetailsOpened}
        onClose={appointmentDetailsHandlers.close}
        title={
          <Text size="xl" fw={700}>
            Appointment Details
          </Text>
        }
        position="right"
        h="100%"
      >
        {appointmentDetails && (
          <AppointmentDetails
            appointment={appointmentDetails}
            onUpdate={handleAppointmentUpdate}
            onRefresh={() => setAppointmentsRefreshTrigger((t) => t + 1)}
          />
        )}
      </Drawer>
      {schedule && (
        <SetAvailabilityModal
          key={`${schedule.id}-${schedule.meta?.versionId ?? ''}`}
          opened={setAvailabilityOpened}
          onClose={() => {
            setAvailabilityHandlers.close();
            refreshSlots();
          }}
          schedule={schedule}
          onSave={(updatedSchedule) => {
            setSchedule(updatedSchedule as WithId<Schedule>);
            medplum.invalidateSearches('Schedule');
            medplum.invalidateSearches('Slot');
          }}
        />
      )}
    </Box>
  );
}
